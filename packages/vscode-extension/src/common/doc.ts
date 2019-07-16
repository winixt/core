import {
  IDocumentModelContentChange,
  ExtensionDocumentDataManager as ExtensionDocumentDataManagerProxy,
} from '@ali/ide-doc-model/lib/common';
import { IDisposable } from '@ali/ide-core-common';

export interface IModelChangedEvent {
  /**
	 * The actual changes.
	 */
  readonly changes: IDocumentModelContentChange[];
  /**
	 * The (new) end-of-line character.
	 */
  readonly eol: string;
  /**
	 * The new version id the model has transitioned to.
	 */
  readonly versionId: number;
}

export interface IMainThreadDocumentsShape extends IDisposable {
  $tryCreateDocument(options?: { language?: string; content?: string; }): Promise<string>;
  $tryOpenDocument(uri: string): Promise<void>;
  $trySaveDocument(uri: string): Promise<boolean>;
}

// tslint:disable-next-line:no-empty-interface
export interface ExtensionDocumentDataManager extends ExtensionDocumentDataManagerProxy {

}
