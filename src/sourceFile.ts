import * as vscode from 'vscode';

export enum SourceFileState {
    unknown,
    modified,
    untracked,
    added,
    removed
}

const myMap = new Map<string, SourceFileState>([
    ["M", SourceFileState.modified],
    ["?", SourceFileState.untracked],
    ["A", SourceFileState.added],
    ["R", SourceFileState.removed]
]);

export class SourceFile {
	public resource: vscode.Uri;
    public state: SourceFileState | undefined;

	constructor(resource: vscode.Uri, state: string) {
		this.resource = resource;

        if(myMap.has(state))
        {
            this.state = myMap.get(state);
        }
    
	}
}