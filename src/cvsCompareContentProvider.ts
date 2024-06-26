/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Schwartzkers. All rights reserved.
 *  Licensed under the MIT License. See License.md in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, ProviderResult, TextDocumentContentProvider, Event,
		 Uri, EventEmitter, Disposable, window, } from "vscode";
import { basename, dirname } from 'path';
import { spawnCmd } from './utility';


export class CvsCompareContentProvider implements TextDocumentContentProvider, Disposable {
	private _onDidChange = new EventEmitter<Uri>();

	constructor() { }

	get onDidChange(): Event<Uri> {
		return this._onDidChange.event;
	}

	dispose(): void {
		this._onDidChange.dispose();
	}

	provideTextDocumentContent(uri: Uri, token: CancellationToken): ProviderResult<string> {
		if (token.isCancellationRequested) {
			// TODO cancel getting repository revision
			// currently it will timeout after 5 secs
			return "Canceled";
		}

		const revision=uri.query;

		return new Promise((resolve) => {
			resolve(this.getRepositoryRevision(uri, revision));
		});
	}

	async getRepositoryRevision(uri: Uri, revision: string): Promise<string> {
		let cvsCmd: string = '';
		if (revision === 'main') {
			cvsCmd = `cvs -Q update -p -A ${basename(uri.fsPath.split(" ("+revision)[0])}`;
		} else {
			cvsCmd = `cvs -Q update -p -r${revision} ${basename(uri.fsPath.split(" ("+revision)[0])}`;
		}
		const result = await spawnCmd(cvsCmd, dirname(uri.fsPath));

		if (!result.result) {
			window.showErrorMessage(`Failed to obtain revision from repository: ${basename(uri.fsPath)}`);
			return "";
		}

		return result.output;
	}
}