/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Schwartzkers. All rights reserved.
 *  Licensed under the MIT License. See License.md in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Uri, TreeItem, TreeDataProvider, TreeItemCollapsibleState, window, ThemeIcon, EventEmitter, Event, Command, workspace } from 'vscode';
import { basename, dirname } from 'path';
import { spawnCmd } from './utility';
import { EOL } from 'os';
import { CVS_SCHEME_COMPARE } from './cvsRepository';
import { SourceFile, SourceFileState } from './sourceFile';
import { findSourceControl } from "./extension";

export class CvsRevisionProvider implements TreeDataProvider<CommitData> {
    private _onDidChangeTreeData: EventEmitter<CommitData | undefined | null | void> = new EventEmitter<CommitData | undefined | null | void>();
    readonly onDidChangeTreeData: Event<CommitData | undefined | null | void> = this._onDidChangeTreeData.event;
    private _enabled: boolean = false;
    private _startup: boolean = true;
    
    constructor(enabled: boolean) { 
        this._enabled = enabled;
    }

    refresh(): any {
        this._onDidChangeTreeData.fire(undefined);
      }

    getTreeItem(element: CommitData): TreeItem {
      return element;
    }

    getChildren(element?: CommitData): Thenable<CommitData[]> {
        if (!this._enabled || element || this._startup) {  // there are no children with children in this tree
            this._startup = false; // ignore on startup because it will be refreshed by seperate event on boot
            return Promise.resolve([]);
        }

        const textEditor = window.activeTextEditor;

        if (textEditor) {
            if (workspace.getWorkspaceFolder(textEditor.document.uri)) {
                return Promise.resolve(this.getDeps(textEditor.document.uri));
            } else {
                return Promise.resolve([]);
            }
        }

        return Promise.reject();
    }

    async getDeps(uri: Uri): Promise<CommitData[]> {
        let commits: CommitData[] = [];

        const sourceFile = await findSourceControl(uri)?.getSourceFile(uri);

        if (sourceFile) {
            // no logs for added or untracked
            if (sourceFile.state === SourceFileState.untracked ||
                sourceFile.state === SourceFileState.added) {
                    return commits;
            }

            if (sourceFile.commitLog) {
                return sourceFile.commitLog;
            }
            else {
                if (sourceFile.repoRevision) {

                    let revision = sourceFile.repoRevision;
                    let loops = 1; // add protection, after 10 loops exit and warn user to avoid infinte loop
                    let gotHeadRev = false;
                    while (true) { // must handle nested branches
                        const log = await this.readCvsLog(uri, revision);

                        if (gotHeadRev === false) {
                            const head = this.getHeadRevison(log);
                            if (sourceFile.workingRevision !== head) {
                                commits = commits.concat(new CommitData(`Head Revision: ${head}`, uri, '', head, '', '', true, false));
                            }
                            gotHeadRev = true;
                        }

                        commits = commits.concat(this.parseCvsLog(log, uri, sourceFile));
        
                        if (revision.search(/^(\d+\.\d+){1}$/) !== -1) { // exit after finding root revision (e.g. 1.3)
                            break;
                        }
        
                        // this file has branch commits, need to determine parent revision
                        // e.g 1.3.2.2 -> 1.3 or 1.3.20.2 -> 1.3 or 1.3.2.2.2.1 -> 1.3.2.2 -> 1.3
                        // get location of second last '.'
                        const parentRevIndex = revision.substring(0, revision.lastIndexOf('.')).lastIndexOf('.');
                        revision = revision.substring(0, parentRevIndex);
        
                        if (loops === 10) {
                            window.showErrorMessage("Error getting cvs log. Too many nested branches.");
                            break;
                        }
                        loops += 1;
                    }
                    sourceFile.commitLog =  commits;
                }
            }
        }

        return commits;
    }

    async readCvsLog(uri: Uri, revision: string): Promise<string> {
        const cvsCmd = `cvs log -N -r:${revision} ${basename(uri.fsPath)}`;
        const result = await spawnCmd(cvsCmd, dirname(uri.fsPath));
        
        if (!result.result || result.output.length === 0) {
            window.showErrorMessage(`Failed to obtain cvs log for resource: ${basename(uri.fsPath)}`);
            return "";
        }

        return result.output;
    }

    parseCvsLog(log: string, uri: Uri, sourceFile: SourceFile): CommitData[] {
        // remove last line "=======""
        let revs = log.split(/\r?\n[=]+\r?\n/)[0].split(/\r?\n-{10,}\r?\nrevision\s/);

        let commits = [];
        let shortMsg = '';
        let commitMsg = '';
        let revision = '';
        let author = '';
        let date = '';

        for (let rev = 1; rev < revs.length; rev++) {
            let commitLines = 0;
            let revSet = false;
            for (const line of revs[rev].split(EOL)) {
                if ( revSet === false) {
                    revision = line.trim();
                    revSet = true;
                } else if ( line.includes("date:") && line.includes("author:") ) {
                    let matcher = line.match(/author:\s(.*?);/);
                    if (matcher) { author = matcher[1]; }

                    matcher = line.match(/date:\s(.{10})\s/);
                    if (matcher) { date = matcher[1]; }
                } else if ( line.includes("branches:") ) { 
                    // TODO ignore for now
                    continue;
                }
                else {
                    if (commitLines < 2) {
                        shortMsg += line.trimEnd() + "  ";
                        commitLines++;
                    }
                    commitMsg += line  + EOL;
                }
            }

            commits.push(new CommitData(shortMsg, uri, commitMsg, revision, author, date, false, sourceFile.workingRevision === revision));
            shortMsg = '';
            commitMsg = '';
        }
        return commits;
    }

    private getHeadRevison(log: string) {
        let head = '';

        for (const line of log.split(EOL)) {
            if (line.includes('head:')) {
                head = line.slice(line.indexOf(':')+2);
                break;
            }
        }

        return head;
    }
}

export class CommitData extends TreeItem {
    constructor(
        public readonly shortMsg: string,
        public readonly uri: Uri,
        private commitMsg: string,
        public readonly revision: string,
        private author: string,
        private date: string,
        private isHead: boolean,
        private isActive: boolean,
    ) {
        let label: any;
        if (isHead) {
            label = shortMsg;
        } else {
            let labelText = revision + "  " + shortMsg.slice(0, 50);

            if (isActive) {
                label = {label: labelText, highlights: [[0,labelText.length]]};
            } else {
                label = labelText;
            }
        }

        super(label, TreeItemCollapsibleState.None);
        this.resourceUri = Uri.from({scheme: CVS_SCHEME_COMPARE, path: uri.path, query: `${this.revision}`});

        if (isHead) {
            this.contextValue = "head";
            this.id = "head";
            this.iconPath = new ThemeIcon("cloud");
            this.tooltip = '';
        } else {
            this.tooltip = this.commitMsg;
            this.description = this.author + ", " + this.date;
            this.iconPath = new ThemeIcon("git-commit");
            if (isActive) {
                this.contextValue = "active_revision";
            } else {
                this.contextValue = "revision";
            }

            this.id = revision;

            // 1.51 or 1.51.2.3
            const revIndex = this.revision.lastIndexOf('.') + 1;
            let revNum = parseInt(this.revision.substring(revIndex));

            let shouldDiff = false;
            let previousRevision = "";
            if (revNum > 1) {
                previousRevision = this.revision.slice(0, revIndex) + (--revNum).toString();
                shouldDiff = true;
            }
            else if (revNum === 1) {
                if (revision.search(/^(\d+\.\d+){1}$/) === -1) { // check if at root revision (1.3)
                    // get parent revision
                    const parentRevIndex = this.revision.substring(0, revision.lastIndexOf('.')).lastIndexOf('.');
                    previousRevision = this.revision.substring(0, parentRevIndex);
                    shouldDiff = true;
                }
            }

            if (shouldDiff) {
                const left = Uri.from({scheme: CVS_SCHEME_COMPARE, path: uri.path, query: `${previousRevision}`});
                
                const right = this.resourceUri;
        
                const command: Command =
                {
                    title: "File History",
                    command: "vscode.diff",
                    arguments: [left, right, `${basename(uri.fsPath)} (${previousRevision}) <-> (${this.revision})`],
                };
                this.command = command;
            }
        }
    }
}
