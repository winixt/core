import { WithEventBus, ComponentRegistryInfo, Emitter, Event, OnEvent, ResizeEvent, RenderedEvent, SlotLocation, CommandRegistry, localize, KeybindingRegistry, ViewContextKeyRegistry, IContextKeyService, getTabbarCtxKey, IContextKey, DisposableCollection } from '@ali/ide-core-browser';
import { Injectable, Autowired } from '@ali/common-di';
import { observable, action, observe, computed } from 'mobx';
import { AbstractContextMenuService, AbstractMenuService, IContextMenu, IMenuRegistry, ICtxMenuRenderer, generateCtxMenu, IMenu, MenuId } from '@ali/ide-core-browser/lib/menu/next';
import { TOGGLE_BOTTOM_PANEL_COMMAND, EXPAND_BOTTOM_PANEL, RETRACT_BOTTOM_PANEL } from '../main-layout.contribution';
import { ResizeHandle } from '@ali/ide-core-browser/lib/components';
import debounce = require('lodash.debounce');
import { TabBarRegistrationEvent, IMainLayoutService } from '../../common';
import { AccordionService } from '../accordion/accordion.service';
import { LayoutState, LAYOUT_STATE } from '@ali/ide-core-browser/lib/layout/layout-state';

export const TabbarServiceFactory = Symbol('TabbarServiceFactory');
export interface TabState {
  hidden: boolean;
  priority: number;
}
const INIT_PANEL_SIZE = 280;

@Injectable({multiple: true})
export class TabbarService extends WithEventBus {
  @observable currentContainerId: string;

  previousContainerId: string = '';

  // 由于 observable.map （即使是deep:false) 会把值转换成observableValue，不希望这样
  containersMap: Map<string, ComponentRegistryInfo> = new Map();
  @observable state: Map<string, TabState> = new Map();

  private storedState: {[containerId: string]: TabState} = {};

  public prevSize?: number;
  public commonTitleMenu: IContextMenu;

  resizeHandle: {
    setSize: (targetSize: number) => void,
    setRelativeSize: (prev: number, next: number) => void,
    getSize: () => number,
    getRelativeSize: () => number[],
    lockSize: (lock: boolean | undefined) => void,
    setMaxSize: (lock: boolean | undefined) => void,
    hidePanel: (show?: boolean) => void,
  };

  @Autowired(AbstractMenuService)
  protected menuService: AbstractMenuService;

  @Autowired(AbstractContextMenuService)
  private readonly ctxmenuService: AbstractContextMenuService;

  @Autowired(IMenuRegistry)
  protected menuRegistry: IMenuRegistry;

  @Autowired(CommandRegistry)
  private commandRegistry: CommandRegistry;

  @Autowired(ICtxMenuRenderer)
  private readonly contextMenuRenderer: ICtxMenuRenderer;

  @Autowired(KeybindingRegistry)
  private keybindingRegistry: KeybindingRegistry;

  @Autowired()
  private viewContextKeyRegistry: ViewContextKeyRegistry;

  @Autowired(IContextKeyService)
  private contextKeyService: IContextKeyService;

  @Autowired(IMainLayoutService)
  private layoutService: IMainLayoutService;

  @Autowired()
  private layoutState: LayoutState;

  private accordionRestored: Set<string> = new Set();

  private readonly onCurrentChangeEmitter = new Emitter<{previousId: string; currentId: string}>();
  readonly onCurrentChange: Event<{previousId: string; currentId: string}> = this.onCurrentChangeEmitter.event;

  private readonly onSizeChangeEmitter = new Emitter<{size: number}>();
  readonly onSizeChange: Event<{size: number}> = this.onSizeChangeEmitter.event;

  public barSize: number;
  private menuId = `tabbar/${this.location}`;
  private isLatter = this.location === SlotLocation.right || this.location === SlotLocation.bottom;
  private activatedKey: IContextKey<string>;
  private rendered = false;
  private sortedContainers: Array<ComponentRegistryInfo> = [];
  private disposableMap: Map<string, DisposableCollection> = new Map();

  private scopedCtxKeyService = this.contextKeyService.createScoped();

  constructor(public location: string, public noAccordion?: boolean) {
    super();
    this.scopedCtxKeyService.createKey('triggerWithTab', true);
    this.menuRegistry.registerMenuItem(this.menuId, {
      command: {
        id: this.registerGlobalToggleCommand(),
        label: localize('layout.tabbar.hide', '隐藏'),
      },
      group: '0_global',
      when: 'triggerWithTab == true',
    });
    this.activatedKey = this.contextKeyService.createKey(getTabbarCtxKey(this.location), '');
    if (this.location === 'bottom') {
      this.registerPanelMenus();
      // TODO: 底部支持多视图
      this.noAccordion = true;
    }
  }

  public getContainerState(containerId: string) {
    const viewState = this.state.get(containerId);
    return viewState!;
  }

  private updatePanel = debounce((show) => {
    if (this.resizeHandle) {
      this.resizeHandle.hidePanel(show);
    }
  }, 60);

  public updatePanelVisibility(show: boolean) {
    this.updatePanel(show);
  }

  @computed({equals: visibleContainerEquals})
  get visibleContainers() {
    const components: ComponentRegistryInfo[] = [];
    this.containersMap.forEach((component) => {
      const state = this.state.get(component.options!.containerId);
      if (!state || !state.hidden) {
        components.push(component);
      }
    });
    // TODO 使用object来存state的话，初始containersMap为空，貌似就无法实现这个监听（无法引用到一个observable的属性）
    // tslint:disable-next-line:no-unused-variable
    const size = this.state.size; // 监听state长度
    // 排序策略：默认根据priority来做一次排序，后续根据存储的index来排序，未存储过的（新插入的，比如插件）在渲染后（时序控制）始终放在最后
    return components.sort((pre, next) =>
      this.getContainerState(pre.options!.containerId).priority - this.getContainerState(next.options!.containerId).priority);
  }

  registerResizeHandle(resizeHandle: ResizeHandle) {
    const {setSize, setRelativeSize, getSize, getRelativeSize, lockSize, setMaxSize, hidePanel} = resizeHandle;
    this.resizeHandle = {
      setSize: (size) => setSize(size, this.isLatter),
      setRelativeSize: (prev: number, next: number) => setRelativeSize(prev, next, this.isLatter),
      getSize: () => getSize(this.isLatter),
      getRelativeSize: () => getRelativeSize(this.isLatter),
      setMaxSize: (lock: boolean | undefined) => setMaxSize(lock, this.isLatter),
      lockSize: (lock: boolean | undefined) => lockSize(lock, this.isLatter),
      hidePanel: (show) => hidePanel(show),
    };
    this.listenCurrentChange();
  }

  @action
  registerContainer(containerId: string, componentInfo: ComponentRegistryInfo) {
    if (this.containersMap.has(containerId)) {
      return;
    }
    const disposables = new DisposableCollection();
    let options = componentInfo.options;
    if (!options) {
      options = {
        containerId,
      };
      componentInfo.options = options;
    }
    this.containersMap.set(containerId, {
      views: componentInfo.views,
      options: observable.object(options, undefined, {deep: false}),
    });
    disposables.push({ dispose: () => {
      this.containersMap.delete(containerId);
      this.state.delete(containerId);
    } });
    this.updatePanelVisibility(this.containersMap.size > 0);
    // 需要立刻设置state，lazy 逻辑会导致computed 的 visibleContainers 可能在计算时触发变更，抛出mobx invariant错误
    // 另外由于containersMap不是observable, 这边setState来触发visibaleContainers更新
    if (this.rendered) {
      // 渲染后状态已恢复，使用状态内的顺序或插到最后
      if (!this.storedState[containerId]) {
        // kaitian拓展都在渲染后注册
        const insertIndex = componentInfo.options!.priority ? Math.max(Math.min(componentInfo.options!.priority, this.sortedContainers.length), 0) : 0;
        this.sortedContainers.splice(insertIndex, 0, componentInfo);
        for (let i = insertIndex; i < this.sortedContainers.length; i++) {
          const info = this.sortedContainers[i];
          this.state.set(info.options!.containerId, {hidden: false, priority: i});
        }
      } else {
        this.state.set(componentInfo.options!.containerId, this.storedState[containerId]);
      }
    } else {
      // 渲染前根据priority排序
      let insertIndex = this.sortedContainers.findIndex((item) => (item.options!.priority || 1) <= (componentInfo.options!.priority || 1));
      if (insertIndex === -1) {
        insertIndex = this.sortedContainers.length;
      }
      this.sortedContainers.splice(insertIndex, 0, componentInfo);
      for (let i = insertIndex; i < this.sortedContainers.length; i++) {
        const info = this.sortedContainers[i];
        this.state.set(info.options!.containerId, {hidden: false, priority: i});
      }
    }
    disposables.push(this.menuRegistry.registerMenuItem(this.menuId, {
      command: {
        id: this.registerVisibleToggleCommand(containerId),
        label: componentInfo.options!.title || '',
      },
      group: '1_widgets',
    }));
    disposables.push(this.registerActivateKeyBinding(componentInfo, options.fromExtension));
    this.eventBus.fire(new TabBarRegistrationEvent({tabBarId: containerId}));
    if (containerId === this.currentContainerId) {
      // 需要重新触发currentChange副作用
      this.handleChange(containerId, '');
    }
    this.viewContextKeyRegistry.registerContextKeyService(containerId, this.contextKeyService.createScoped()).createKey('view', containerId);
    this.disposableMap.set(containerId, disposables);
  }

  @action
  disposeContainer(containerId: string) {
    const disposables = this.disposableMap.get(containerId);
    if (disposables) {
      disposables.dispose();
    }
  }

  getContainer(containerId: string) {
    return this.containersMap.get(containerId);
  }

  getTitleToolbarMenu(containerId: string) {
    const menu = this.menuService.createMenu(MenuId.ViewTitle, this.viewContextKeyRegistry.getContextKeyService(containerId));
    return menu;
  }

  doExpand(expand: boolean) {
    const {setRelativeSize} = this.resizeHandle;
    if (expand) {
      if (!this.isLatter) {
        setRelativeSize(1, 0);
      } else {
        setRelativeSize(0, 1);
      }
    } else {
      // FIXME 底部需要额外的字段记录展开前的尺寸
      setRelativeSize(2, 1);
    }
  }

  get isExpanded(): boolean {
    const {getRelativeSize} = this.resizeHandle;
    const relativeSizes = getRelativeSize().join(',');
    return this.isLatter ? relativeSizes === '0,1' : relativeSizes === '1,0';
  }

  @action.bound handleTabClick(
    e: React.MouseEvent,
    forbidCollapse?: boolean) {
    const containerId = e.currentTarget.id;
    if (containerId === this.currentContainerId && !forbidCollapse) {
      this.currentContainerId = '';
    } else {
      this.currentContainerId = containerId;
    }
  }

  @action.bound handleContextMenu(event: React.MouseEvent, containerId?: string) {
    event.preventDefault();
    event.stopPropagation();
    const menus = this.menuService.createMenu(this.menuId, containerId ? this.scopedCtxKeyService : this.contextKeyService);
    const menuNodes = generateCtxMenu({ menus, args: [{containerId}] });
    this.contextMenuRenderer.show({ menuNodes: menuNodes[1], anchor: {
      x: event.clientX,
      y: event.clientY,
    } });
  }

  // drag & drop
  handleDragStart(e: React.DragEvent, containerId: string) {
    e.dataTransfer.setData('containerId', containerId);
  }
  handleDrop(e: React.DragEvent, target: string) {
    if (e.dataTransfer.getData('containerId')) {
      const containerId = e.dataTransfer.getData('containerId');
      const sourceState = this.getContainerState(containerId);
      const targetState = this.getContainerState(target);
      const sourcePriority = sourceState.priority;
      sourceState.priority = targetState.priority;
      targetState.priority = sourcePriority;
      this.storeState();
    }
  }

  restoreState() {
    this.storedState = this.layoutState.getState(LAYOUT_STATE.getTabbarSpace(this.location), {});
    for (const containerId of this.state.keys()) {
      if (this.storedState[containerId]) {
        this.state.set(containerId, this.storedState[containerId]);
      }
    }
  }

  protected storeState() {
    const stateObj = {};
    this.state.forEach((value, key) => {
      stateObj[key] = value;
    });
    this.layoutState.setState(LAYOUT_STATE.getTabbarSpace(this.location), stateObj);
  }

  // 注册Tab的激活快捷键，对于底部panel，为切换快捷键
  private registerActivateKeyBinding(component: ComponentRegistryInfo, fromExtension?: boolean) {
    const options = component.options!;
    const containerId = options.containerId;
    // vscode内插件注册的是workbench.view.extension.containerId
    const activateCommandId = fromExtension ? `workbench.view.extension.${containerId}` : `workbench.view.${containerId}`;
    const disposables = new DisposableCollection();
    disposables.push(this.commandRegistry.registerCommand({
      id: activateCommandId,
    }, {
      execute: ({forceShow}: {forceShow?: boolean} = {}) => {
        // 支持toggle
        if (this.location === 'bottom' && !forceShow) {
          this.currentContainerId = this.currentContainerId === containerId ? '' : containerId;
        } else {
          this.currentContainerId = containerId;
        }
      },
    }));
    if (options.activateKeyBinding) {
      disposables.push(this.keybindingRegistry.registerKeybinding({
        command: activateCommandId,
        keybinding: options.activateKeyBinding!,
      }));
    }
    return disposables;
  }

  private registerGlobalToggleCommand() {
    const commandId = `activity.bar.toggle.${this.location}`;
    this.commandRegistry.registerCommand({
      id: commandId,
    }, {
      execute: ({containerId}: {containerId: string}) => {
        this.doToggleTab(containerId);
      },
      isEnabled: () => {
        return this.visibleContainers.length > 1;
      },
    });
    return commandId;
  }

  // 注册tab的隐藏显示功能
  private registerVisibleToggleCommand(containerId: string): string {
    const commandId = `activity.bar.toggle.${containerId}`;
    this.commandRegistry.registerCommand({
      id: commandId,
    }, {
      execute: ({forceShow}: {forceShow?: boolean} = {}) => {
        this.doToggleTab(containerId, forceShow);
      },
      isToggled: () => {
        const state = this.getContainerState(containerId);
        return !state.hidden;
      },
      isEnabled: () => {
        const state = this.getContainerState(containerId);
        return state.hidden || this.visibleContainers.length !== 1;
      },
    });
    return commandId;
  }

  protected registerPanelMenus() {
    this.menuRegistry.registerMenuItems('tabbar/bottom/common', [
      {
        command: {
          id: EXPAND_BOTTOM_PANEL.id,
          label: localize('layout.tabbar.expand', '最大化面板'),
        },
        group: 'navigation',
        when: '!bottomFullExpanded',
        order: 1,
      },
      {
        command: {
          id: RETRACT_BOTTOM_PANEL.id,
          label: localize('layout.tabbar.retract', '恢复面板'),
        },
        group: 'navigation',
        when: 'bottomFullExpanded',
        order: 1,
      },
      {
        command: {
          id: TOGGLE_BOTTOM_PANEL_COMMAND.id,
          label: localize('layout.tabbar.hide', '收起面板'),
        },
        group: 'navigation',
        order: 2,
      },
    ]);
    this.commonTitleMenu = this.ctxmenuService.createMenu({
      id: 'tabbar/bottom/common',
    });
  }

  protected doToggleTab(containerId: string, forceShow?: boolean) {
    const state = this.getContainerState(containerId);
    if (forceShow === undefined) {
      state.hidden = !state.hidden;
    } else {
      state.hidden = !forceShow;
    }
    if (state.hidden) {
      if (this.currentContainerId === containerId) {
        this.currentContainerId = this.visibleContainers[0].options!.containerId;
      }
    }
    this.storeState();
  }

  @OnEvent(RenderedEvent)
  protected async onDidRender() {
    this.restoreState();
    this.rendered = true;
  }

  protected shouldExpand(containerId: string) {
    const info = this.getContainer(containerId);
    return info && info.options && info.options.expanded;
  }

  @OnEvent(ResizeEvent)
  protected onResize(e: ResizeEvent) {
    if (e.payload.slotLocation === this.location) {
      if (!this.currentContainerId) {
        // 折叠时不监听变化
        return;
      }
      const size = this.resizeHandle.getSize();
      if (size !== this.barSize && !this.shouldExpand(this.currentContainerId)) {
        this.prevSize = size;
        this.onSizeChangeEmitter.fire({size});
      }
    }
  }

  protected listenCurrentChange() {
    observe(this, 'currentContainerId', (change) => {
      if (this.prevSize === undefined) {
      }
      this.previousContainerId = change.oldValue || '';
      const currentId = change.newValue;
      this.handleChange(currentId, this.previousContainerId);
    });
  }

  private handleChange(currentId, previousId) {
    const {getSize, setSize, lockSize, setMaxSize} = this.resizeHandle;
    this.onCurrentChangeEmitter.fire({previousId, currentId});
    const isCurrentExpanded = this.shouldExpand(currentId);
    if (this.shouldExpand(this.previousContainerId) || isCurrentExpanded) {
      this.handleFullExpanded(currentId, isCurrentExpanded);
    } else {
      if (currentId) {
        if (previousId && currentId !== previousId) {
          this.prevSize = getSize();
        }
        setSize(this.prevSize || (INIT_PANEL_SIZE + this.barSize));
        const containerInfo = this.getContainer(currentId);
        if (containerInfo && containerInfo.options!.noResize) {
          lockSize(true);
        } else {
          lockSize(false);
        }
        setMaxSize(false);
        if (!this.noAccordion) {
          this.tryRestoreAccordionSize(currentId);
        }
        this.activatedKey.set(currentId);
      } else {
        setSize(this.barSize);
        lockSize(true);
        setMaxSize(true);
      }
    }
  }

  protected tryRestoreAccordionSize(containerId: string) {
    if (this.accordionRestored.has(containerId)) {
      return;
    }
    const containerInfo = this.containersMap.get(containerId);
    // 使用自定义视图取代手风琴的面板不需要restore
    if (!containerInfo || containerInfo.options!.component) {
      return;
    }
    const accordionService = this.layoutService.getAccordionService(containerId);
    // 需要保证此时tab切换已完成dom渲染
    setTimeout(() => {
      accordionService.restoreState();
      this.accordionRestored.add(containerId);
    }, 0);
  }

  protected handleFullExpanded(currentId: string, isCurrentExpanded?: boolean) {
    const { setRelativeSize, setSize } = this.resizeHandle;
    if (currentId) {
      if (isCurrentExpanded) {
        if (!this.isLatter) {
          setRelativeSize(1, 0);
        } else {
          setRelativeSize(0, 1);
        }
      } else {
        setSize(this.prevSize || INIT_PANEL_SIZE + this.barSize);
      }
    } else {
      setSize(this.barSize);
    }
  }

}

function visibleContainerEquals(a: ComponentRegistryInfo[], b: ComponentRegistryInfo[]): boolean {
  if (a.length !== b.length ) {
    return false;
  } else {
    let isEqual = true;
    for (let i = 0; i < a.length; i ++) {
      if (a[i] !== b[i]) {
        isEqual = false;
        break;
      }
    }
    return isEqual;
  }
}
