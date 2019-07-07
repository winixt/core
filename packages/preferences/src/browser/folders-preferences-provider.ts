import { Autowired, Injectable } from '@ali/common-di';
import { URI, PreferenceProvider, PreferenceResolveResult, PreferenceConfigurations } from '@ali/ide-core-browser';
import { FolderPreferenceProvider, FolderPreferenceProviderFactory, FolderPreferenceProviderOptions } from './folder-preference-provider';
import { WorkspaceService } from '@ali/ide-workspace/lib/browser';
@Injectable()
export class FoldersPreferencesProvider extends PreferenceProvider {

  @Autowired(FolderPreferenceProviderFactory)
  protected readonly folderPreferenceProviderFactory: FolderPreferenceProviderFactory;

  @Autowired(PreferenceConfigurations)
  protected readonly configurations: PreferenceConfigurations;

  @Autowired(WorkspaceService)
  protected readonly workspaceService: WorkspaceService;

  protected readonly providers = new Map<string, FolderPreferenceProvider>();

  constructor() {
    super();
    this.init();
  }

  protected async init(): Promise<void> {
    await this.workspaceService.roots;

    this.updateProviders();
    this.workspaceService.onWorkspaceChanged(() => this.updateProviders());

    const readyPromises: Promise<void>[] = [];
    for (const provider of this.providers.values()) {
      readyPromises.push(provider.ready.catch((e) => console.error(e)));
    }
    Promise.all(readyPromises).then(() => this._ready.resolve());
  }

  protected updateProviders(): void {
    const roots = this.workspaceService.tryGetRoots();
    const toDelete = new Set(this.providers.keys());
    for (const folder of roots) {
      for (const configPath of this.configurations.getPaths()) {
        for (const configName of [...this.configurations.getSectionNames(), this.configurations.getConfigName()]) {
          const configUri = this.configurations.createUri(new URI(folder.uri), configPath, configName);
          const key = configUri.toString();
          toDelete.delete(key);
          if (!this.providers.has(key)) {
            const provider = this.createProvider({ folder, configUri });
            this.providers.set(key, provider);
          }
        }
      }
    }
    for (const key of toDelete) {
      const provider = this.providers.get(key);
      if (provider) {
        this.providers.delete(key);
        provider.dispose();
      }
    }
  }

  getConfigUri(resourceUri?: string): URI | undefined {
    for (const provider of this.getFolderProviders(resourceUri)) {
      const configUri = provider.getConfigUri(resourceUri);
      if (this.configurations.isConfigUri(configUri)) {
        return configUri;
      }
    }
    return undefined;
  }

  getContainingConfigUri(resourceUri?: string): URI | undefined {
    for (const provider of this.getFolderProviders(resourceUri)) {
      const configUri = provider.getConfigUri();
      if (this.configurations.isConfigUri(configUri) && provider.contains(resourceUri)) {
        return configUri;
      }
    }
    return undefined;
  }

  getDomain(): string[] {
    return this.workspaceService.tryGetRoots().map((root) => root.uri);
  }

  resolve<T>(preferenceName: string, resourceUri?: string): PreferenceResolveResult<T> {
    const result: PreferenceResolveResult<T> = {};
    const groups = this.groupProvidersByConfigName(resourceUri);
    for (const group of groups.values()) {
      for (const provider of group) {
        const { value, configUri } = provider.resolve<T>(preferenceName, resourceUri);
        if (configUri && value !== undefined) {
          result.configUri = configUri;
          result.value = PreferenceProvider.merge(result.value as any, value as any) as any;
          break;
        }
      }
    }
    return result;
  }

  getPreferences(resourceUri?: string): { [p: string]: any } {
    let result = {};
    const groups = this.groupProvidersByConfigName(resourceUri);
    for (const group of groups.values()) {
      for (const provider of group) {
        if (provider.getConfigUri(resourceUri)) {
          const preferences = provider.getPreferences();
          result = PreferenceProvider.merge(result, preferences) as any;
          break;
        }
      }
    }
    return result;
  }

  async setPreference(preferenceName: string, value: any, resourceUri?: string): Promise<boolean> {
    const sectionName = preferenceName.split('.', 1)[0];
    const configName = this.configurations.isSectionName(sectionName) ? sectionName : this.configurations.getConfigName();

    const providers = this.getFolderProviders(resourceUri);
    let configPath: string | undefined;

    const iterator: (() => FolderPreferenceProvider | undefined)[] = [];
    for (const provider of providers) {
      if (configPath === undefined) {
        const configUri = provider.getConfigUri(resourceUri);
        if (configUri) {
          configPath = this.configurations.getPath(configUri);
        }
      }
      if (this.configurations.getName(provider.getConfigUri()) === configName) {
        iterator.push(() => {
          if (provider.getConfigUri(resourceUri)) {
            return provider;
          }
          iterator.push(() => {
            if (this.configurations.getPath(provider.getConfigUri()) === configPath) {
              return provider;
            }
            iterator.push(() => provider);
          });
        });
      }
    }

    let next = iterator.shift();
    while (next) {
      const provider = next();
      if (provider) {
        if (await provider.setPreference(preferenceName, value, resourceUri)) {
          return true;
        }
      }
      next = iterator.shift();
    }
    return false;
  }

  protected groupProvidersByConfigName(resourceUri?: string): Map<string, FolderPreferenceProvider[]> {
    const groups = new Map<string, FolderPreferenceProvider[]>();
    const providers = this.getFolderProviders(resourceUri);
    for (const configName of [this.configurations.getConfigName(), ...this.configurations.getSectionNames()]) {
      const group: any[] = [];
      for (const provider of providers) {
        if (this.configurations.getName(provider.getConfigUri()) === configName) {
          group.push(provider);
        }
      }
      groups.set(configName, group);
    }
    return groups;
  }

  protected getFolderProviders(resourceUri?: string): FolderPreferenceProvider[] {
    if (!resourceUri) {
      return [];
    }
    const resourcePath = new URI(resourceUri).path;
    let folder: Readonly<{ relativity: number, uri?: string }> = { relativity: Number.MAX_SAFE_INTEGER };
    const providers = new Map<string, FolderPreferenceProvider[]>();
    for (const provider of this.providers.values()) {
      const uri = provider.folderUri.toString();
      const folderProviders = (providers.get(uri) || []);
      folderProviders.push(provider);
      providers.set(uri, folderProviders);

      const relativity = provider.folderUri.path.relativity(resourcePath);
      if (relativity >= 0 && folder.relativity > relativity) {
        folder = { relativity, uri };
      }
    }
    return folder.uri && providers.get(folder.uri) || [];
  }

  protected createProvider(options: FolderPreferenceProviderOptions): FolderPreferenceProvider {
    const provider = this.folderPreferenceProviderFactory(options);
    this.toDispose.push(provider);
    this.toDispose.push(provider.onDidPreferencesChanged((change) => this.onDidPreferencesChangedEmitter.fire(change)));
    return provider;
  }

}
