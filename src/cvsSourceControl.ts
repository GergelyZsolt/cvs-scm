import { scm, SourceControl, SourceControlResourceGroup, SourceControlResourceState,
		 CancellationTokenSource, Uri, ExtensionContext, Command, Disposable,
		 workspace, RelativePattern, window, commands } from 'vscode';
import { promises as fsPromises } from 'fs';
import { CvsRepository } from './cvsRepository';
import { SourceFileState, SourceFile } from './sourceFile';
import { CvsDocumentContentProvider } from './cvsDocumentContentProvider';
import { execCmd, readDir, readFile, writeFile, deleteUri, createDir, spawnCmd } from './utility';
import { dirname, basename } from 'path';
import { ConfigManager} from './configManager';
import { EOL } from 'os';
import { CommitData } from './cvsRevisionProvider';
import { BranchData } from './cvsBranchProvider';
import { updateStatusBarItem, updateFileHistoryTree, updateBranchesTree } from './extension';

export class CvsSourceControl implements Disposable {
	private cvsScm: SourceControl;
	private workspacefolder: Uri;
	private cvsDocumentContentProvider: CvsDocumentContentProvider;
	private stagedResources: SourceControlResourceGroup;
	private changedResources: SourceControlResourceGroup;
	private repositoryResources: SourceControlResourceGroup;
	private conflictResources: SourceControlResourceGroup;
	private unknownResources: SourceControlResourceGroup;
	private cvsRepository: CvsRepository;
	private timeout?: NodeJS.Timer;
	private stagedFiles: string[];
	private configManager: ConfigManager;
	private _startup: boolean = true;


	constructor(context: ExtensionContext,
			worspacefolder: Uri,
			cvsDocumentContentProvider: CvsDocumentContentProvider,
			configManager: ConfigManager) {
		this.cvsScm = scm.createSourceControl('cvs', 'CVS', worspacefolder);
		this.workspacefolder = worspacefolder;
		this.cvsDocumentContentProvider = cvsDocumentContentProvider;
		this.configManager = configManager;
		this.stagedResources = this.cvsScm.createResourceGroup('stagingTree', 'Staged Changes');
		this.changedResources = this.cvsScm.createResourceGroup('changeTree', 'Changes');
		this.repositoryResources = this.cvsScm.createResourceGroup('repositoryTree', 'Repository Changes');
		this.conflictResources = this.cvsScm.createResourceGroup('conflictTree', 'Conflicts');
		this.unknownResources = this.cvsScm.createResourceGroup('untrackedTree', 'Untracked');

		this.stagedResources.hideWhenEmpty = true;
		this.changedResources.hideWhenEmpty = true;
		this.repositoryResources.hideWhenEmpty = true;
		this.conflictResources.hideWhenEmpty = true;
		this.unknownResources.hideWhenEmpty = true;

		this.stagedFiles = [];
		
		this.cvsRepository = new CvsRepository(this.workspacefolder, this.configManager);
		this.cvsScm.quickDiffProvider = this.cvsRepository;
		this.cvsScm.inputBox.placeholder = 'Commit Message';

		const fileSystemWatcher = workspace.createFileSystemWatcher(new RelativePattern(this.workspacefolder, '**/*'));
		fileSystemWatcher.onDidChange(uri => this.onResourceChange(uri), context.subscriptions);
		fileSystemWatcher.onDidCreate(uri => this.onResourceChange(uri), context.subscriptions);
		fileSystemWatcher.onDidDelete(uri => this.onResourceChange(uri), context.subscriptions);

		context.subscriptions.push(this.cvsScm);
		context.subscriptions.push(fileSystemWatcher);
	}

	getWorkspaceFolder(): Uri {
		return this.workspacefolder;
	}

	getCvsState(): void {
		this.onResourceChange(this.workspacefolder);
	}

	onResourceChange(_uri: Uri): void {
		if (this.timeout) { clearTimeout(this.timeout); }
		this.timeout = setTimeout(() => this.getResourceChanges(_uri), 500);
	}

	async getResourceChanges(event: Uri): Promise<void> {
		await this.cvsRepository.getResources();
		this.refreshScm();
	}

	refreshScm(): void {
		const stagedResources: SourceControlResourceState[] = [];
		const changedResources: SourceControlResourceState[] = [];
		const repositoryResources: SourceControlResourceState[] = [];
		const conflictResources: SourceControlResourceState[] = [];
		const unknownResources: SourceControlResourceState[] = [];
		
		this.cvsRepository.getChangesSourceFiles().forEach(element => {

			// check if resource is staged
			let isStaged = false;			
			this.stagedFiles.forEach(resource => {
				if (resource === element.uri.fsPath) {
					isStaged = true;
				}
			});

			if(element.state === SourceFileState.modified)
			{
				const token = new CancellationTokenSource();
				const left = this.cvsRepository.provideOriginalResource!(element.uri, token.token);
				let right = element.uri;

				const command: Command =
				{
					title: "Show changes",
					command: "vscode.diff",
					arguments: [left, right, `${basename(element.uri.fsPath)} (${this.changedResources.label})`],
					tooltip: "Diff your changes"
				};

				const resourceState: SourceControlResourceState = {
					resourceUri: element.uri,
					command: command,
					contextValue: 'modified',
					decorations: {
						strikeThrough: false,
						dark:{
							iconPath: __dirname + "/../resources/icons/dark/modified.svg",
						},
						light: {
							iconPath: __dirname + "/../resources/icons/light/modified.svg",
						},
						tooltip: "Locally Modified"
					}};
				
				if (isStaged) {
					stagedResources.push(resourceState);
				} else {
					changedResources.push(resourceState);
				}
			} else if (element.state === SourceFileState.untracked)
			{
				let type = "untracked_file";
				let tip = "Unknown File";
				if (element.isFolder) {
					type = "untracked_folder";
					tip = "Unknown Folder";
				}

				const resourceState: SourceControlResourceState = {
					resourceUri: element.uri,
					contextValue: type,
					decorations: {
						dark:{
							iconPath: __dirname + "/../resources/icons/dark/untracked.svg",
						},
						light: {
							iconPath: __dirname + "/../resources/icons/light/untracked.svg",
						},
						tooltip: tip
					}};

				unknownResources.push(resourceState);
			} else if (element.state === SourceFileState.added) {
				const resourceState: SourceControlResourceState = {
					resourceUri: element.uri,
					contextValue: "added",
					decorations: {
						dark:{
							iconPath: __dirname + "/../resources/icons/dark/added.svg",
						},
						light: {
							iconPath: __dirname + "/../resources/icons/light/added.svg",
						},
						tooltip: "Locally Added"
					}};

				if (isStaged) {
					stagedResources.push(resourceState);
				} else {
					changedResources.push(resourceState);
				}
			} else if (element.state === SourceFileState.removed) {
				// cannot provide diff once "cvs remove" executed
				const resourceState: SourceControlResourceState = {
					resourceUri: element.uri,					
					contextValue: "removed",
					decorations: {
						strikeThrough: true,						
						dark:{
							iconPath: __dirname + "/../resources/icons/dark/removed.svg",
						},
						light: {
							iconPath: __dirname + "/../resources/icons/light/removed.svg",
						},
						tooltip: "Locally Removed"
					}};

				if (isStaged) {
					stagedResources.push(resourceState);
				} else {
					changedResources.push(resourceState);
				}
			} else if (element.state === SourceFileState.deleted) {
				const token = new CancellationTokenSource();
				let left = this.cvsRepository.provideOriginalResource!(element.uri, token.token);
				let right = "";

				const command: Command =
				{
					title: "Show changes",
					command: "vscode.diff",
					arguments: [left, right, `${basename(element.uri.fsPath)} (${this.changedResources.label})`],
					tooltip: "View remote changes"
				};

				const resourceState: SourceControlResourceState = {
					resourceUri: element.uri,					
					contextValue: "deleted",
					command: command,			
					decorations: {
						strikeThrough: true,						
						dark:{
							iconPath: __dirname + "/../resources/icons/dark/deleted.svg",
						},
						light: {
							iconPath: __dirname + "/../resources/icons/light/deleted.svg",
						},
						tooltip: "Deleted"
					}};

				changedResources.push(resourceState);
			} else if (element.state === SourceFileState.conflict) {				
				const command: Command =
				{
					title: "View conflicts",
					command: "vscode.open",
					arguments: [element.uri],
					tooltip: "Open file"
				};

				const resourceState: SourceControlResourceState = {
					resourceUri: element.uri,
					contextValue: "conflict",
					command: command,
					decorations: {						
						dark:{
							iconPath: __dirname + "/../resources/icons/dark/conflict.svg",
						},
						light: {
							iconPath: __dirname + "/../resources/icons/light/conflict.svg",
						},
						tooltip: "Contains Conflicts"
					}};

				conflictResources.push(resourceState);
			} else if (element.state === SourceFileState.patch) {
				const token = new CancellationTokenSource();
				let left = this.cvsRepository.provideOriginalResource!(element.uri, token.token);
				let right = element.uri;

				const command: Command =
				{
					title: "Show changes",
					command: "vscode.diff",
					arguments: [left, right, `${basename(element.uri.fsPath)} (${this.repositoryResources.label})`],
					tooltip: "View remote changes"
				};

				const resourceState: SourceControlResourceState = {
					resourceUri: element.uri,
					command: command,				
					contextValue: "patch",
					decorations: {						
						dark:{
							iconPath: __dirname + "/../resources/icons/dark/patch.svg",
						},
						light: {
							iconPath: __dirname + "/../resources/icons/light/patch.svg",
						},
						tooltip: "Needs Patch"
					}};

				repositoryResources.push(resourceState);
			} else if (element.state === SourceFileState.merge) {
				const token = new CancellationTokenSource();
				let left = this.cvsRepository.provideOriginalResource!(element.uri, token.token);
				let right = element.uri;

				const command: Command =
				{
					title: "Show changes",
					command: "vscode.diff",
					arguments: [left, right, `${basename(element.uri.fsPath)} (${this.repositoryResources.label})`],
					tooltip: "View remote changes"
				};

				const resourceState: SourceControlResourceState = {
					resourceUri: element.uri,
					command: command,
					contextValue: "merge",
					decorations: {						
						dark:{
							iconPath: __dirname + "/../resources/icons/dark/merge.svg",
						},
						light: {
							iconPath: __dirname + "/../resources/icons/light/merge.svg",
						},
						tooltip: "Needs Merge"
					}};

				repositoryResources.push(resourceState);
			} else if (element.state === SourceFileState.checkout) {
				const token = new CancellationTokenSource();
				let left = this.cvsRepository.provideOriginalResource!(element.uri, token.token);
				let right = "";

				const command: Command =
				{
					title: "Show changes",
					command: "vscode.diff",
					arguments: [left, right, `${basename(element.uri.fsPath)} (${this.repositoryResources.label})`],
					tooltip: "View remote changes"
				};

				const resourceState: SourceControlResourceState = {
					resourceUri: element.uri,
					command: command,
					contextValue: "checkout",
					decorations: {						
						dark:{
							iconPath: __dirname + "/../resources/icons/dark/checkout.svg",
						},
						light: {
							iconPath: __dirname + "/../resources/icons/light/checkout.svg",
						},
						tooltip: "Needs Checkout"
					}};

				repositoryResources.push(resourceState);
			}
			else if (element.state === SourceFileState.removedFromRepo) {
				const token = new CancellationTokenSource();
				let left = "";
				let right = element.uri;

				const command: Command =
				{
					title: "Show changes",
					command: "vscode.diff",
					arguments: [left, right, `${basename(element.uri.fsPath)} (${this.repositoryResources.label})`],
					tooltip: "View remote changes"
				};

				const resourceState: SourceControlResourceState = {
					resourceUri: element.uri,
					command: command,
					contextValue: "removedFromRepo",
					decorations: {			
						strikeThrough: true,			
						dark:{
							iconPath: __dirname + "/../resources/icons/dark/removed.svg",
						},
						light: {
							iconPath: __dirname + "/../resources/icons/light/removed.svg",
						},
						tooltip: "Removed from Repository"
					}};

				repositoryResources.push(resourceState);
			} else if (element.state === SourceFileState.directory) {
				const resourceState: SourceControlResourceState = {
					resourceUri: element.uri,
					contextValue: "directory",
					decorations: {			
						dark:{
							iconPath: __dirname + "/../resources/icons/dark/folder.svg",
						},
						light: {
							iconPath: __dirname + "/../resources/icons/light/folder.svg",
						},
						tooltip: "Folder found in Repository"
					}};

				repositoryResources.push(resourceState);
			}		
		});
		
		this.stagedResources.resourceStates = stagedResources;
		this.changedResources.resourceStates = changedResources;
		this.repositoryResources.resourceStates = repositoryResources;
		this.conflictResources.resourceStates = conflictResources;
		this.unknownResources.resourceStates = unknownResources;

		if (this._startup) {
			this._startup = false; // there's nothing to update on startup
		} else {
			this.cvsDocumentContentProvider.updated(changedResources.concat(conflictResources, stagedResources, repositoryResources));
		}

		updateFileHistoryTree();
		updateBranchesTree();
		updateStatusBarItem(window.activeTextEditor);
	}

	async commitAll(): Promise<void> {
		if (!this.stagedResources.resourceStates.length) {
			window.showErrorMessage("There are no staged changes to commit.");
			return;
		}
		else if (this.cvsScm.inputBox.value.length === 0) {
			window.showErrorMessage("Missing commit message.");
			return;
		}

		// need list of files relative to root 
		let files = '';
		this.stagedResources.resourceStates.forEach(element => {			
			files = files.concat(workspace.asRelativePath(element.resourceUri, false) + ' ');
		});

		if ( (await execCmd(`cvs commit -m "${this.cvsScm.inputBox.value}" ${files}`, this.workspacefolder.fsPath)).result) {
			this.stagedFiles = [];
			this.cvsScm.inputBox.value = '';
		} else {
			window.showErrorMessage('Failed to commit changes');
		};		
	}

	async stageFile(uri: Uri, refresh: boolean=true): Promise<void> {
		if (!this.stagedFiles.includes(uri.fsPath)) {
			// add to staging cache
			this.stagedFiles.push(uri.fsPath);
		}

		if (refresh) {
			this.refreshScm();
		}		
	}

	async unstageFile(uri: Uri, refresh: boolean=true): Promise<void> {
		if (this.stagedFiles.includes(uri.fsPath)) {
			// remove from staging cache
			let index = this.stagedFiles.indexOf(uri.fsPath, 0);
			if (index > -1) {
				this.stagedFiles.splice(index, 1);
			}
		}

		if (refresh) {
			this.refreshScm();
		}
	}

	async stageAll(): Promise<void> {
		if (this.changedResources.resourceStates.length === 0) {
			window.showErrorMessage("There are no changes to stage.");
			return;
		}

		for (const resource of this.changedResources.resourceStates) {
			// automatically "cvs remove" any deleted files
			if (resource.contextValue === 'deleted') {
				await this.removeFileFromCvs(resource.resourceUri);
			}
			this.stageFile(resource.resourceUri, false);
		};

		this.refreshScm();
	}

	async unstageAll(): Promise<void> {
		if (this.stagedResources.resourceStates.length === 0) {
			window.showErrorMessage("There are no changes to unstage.");
			return;
		}

		this.stagedFiles = [];
		this.refreshScm();
	}

	async forceRevert(uri: Uri): Promise<void> {
		if (await deleteUri(uri)) {
			await this.revertFile(uri);
		} else {
			window.showErrorMessage(`Failed to revert file to HEAD: ${basename(uri.fsPath)}`);
		}
	}

	async addFile(uri: Uri): Promise<void>  {
		const response = await execCmd(`cvs add ${basename(uri.fsPath)}`, dirname(uri.fsPath));

		if(!response.result) {
			window.showErrorMessage(`Failed to schedule file for addition: ${basename(uri.fsPath)}`);
		}
	}

	async removeFileFromCvs(uri: Uri): Promise<void>  {
		const response = await execCmd(`cvs remove -f ${basename(uri.fsPath)}`, dirname(uri.fsPath));

		if(!response.result) {
			window.showErrorMessage(`Failed to schedule file for removal: ${basename(uri.fsPath)}`);
		}
	}

	async recoverDeletedFile(uri: Uri): Promise<void>  {
		this.unstageFile(uri, false); // in case staged

		const response = await execCmd(`cvs update ${basename(uri.fsPath)}`, dirname(uri.fsPath));

		if(!response.result) {
			window.showErrorMessage(`Failed to recover deleted file: ${basename(uri.fsPath)}`);
		}
	}

	async revertFile(uri: Uri): Promise<void> {
		this.unstageFile(uri, false); // in case staged

		const response = await execCmd(`cvs update -C ${basename(uri.fsPath)}`, dirname(uri.fsPath));

		if(!response.result) {
			window.showErrorMessage(`Failed to revert file to HEAD: ${basename(uri.fsPath)}`);
		}
	}

	async mergeLatest(uri: Uri): Promise<void>  {
		// TODO how to handle errors
		// cvs update will report errors if merge results in conflicts
		//   csmerge: warning: conflicts during merge
		//   cvs update: conflicts found in newfile3.cpp
		// no errors with patching
		// no errors on checkout new file
		// stderr on removal "cvs update: `nov17.cpp' is no longer in the repository"
		await execCmd(`cvs update ${basename(uri.fsPath)}`, dirname(uri.fsPath));
	}

	// can only do this if file was untracked by repository
	async undoAdd(uri: Uri): Promise<void>  {
		this.unstageFile(uri, false); // in case staged

		let success = false;

		// 1. remove temp CVS file (e.g. 'test.txt,t')
		const files = await readDir(dirname(uri.fsPath) + '/CVS');
		if (files.length > 0) {
			for (const file of files) {
				if (file.includes(basename(uri.fsPath))) {
					success = await deleteUri(Uri.parse(dirname(uri.fsPath) + '/CVS/' + file));
					break;
				}
			}

			// 2. get lines from Entries to add to the new Entries file
			let newEntries = '';
			if (success) {
				success = false; // reset for next block of logic
				
				const lines = await readFile(dirname(uri.fsPath) + '/CVS/Entries');
				if (lines && lines.length > 0) {
					for (const line of lines.split(EOL)) {
						// do not include the line in Entries to be discarded
						if (line.includes(basename(uri.fsPath)) === false) {
							newEntries = newEntries.concat(line + EOL);
						}
					}
					success = true;
				}
			}

			// 3. create new Entries file and remove old Entires
			if (success) {
				success = false; // reset for next block of logic

				if (await writeFile(dirname(uri.fsPath) + '/CVS/Entries.out', newEntries) &&
					await fsPromises.rename(dirname(uri.fsPath) + '/CVS/Entries', dirname(uri.fsPath) + '/CVS/Entries.bak') === undefined) {						
					if (await fsPromises.rename(dirname(uri.fsPath) + '/CVS/Entries.out', dirname(uri.fsPath) + '/CVS/Entries') === undefined) {
						await fsPromises.unlink(dirname(uri.fsPath) + '/CVS/Entries.bak');
						success = true;
					}
					else {
						// attempt to revert to old Entries
						await fsPromises.rename(dirname(uri.fsPath) + '/CVS/Entries.bak', dirname(uri.fsPath) + '/CVS/Entries');
					}						
				}
			}
		}

		if (!success) {
			window.showErrorMessage(`Failed to discard add of file: ${basename(uri.fsPath)}`);
		}
	}

	async deleteResource(uri: Uri): Promise<void>  {
		if(!(await deleteUri(uri))) {
			window.showErrorMessage(`Failed to delete: ${basename(uri.fsPath)}`);
		}
	}

	async ignoreFolder(uri: Uri): Promise<void>  {
		await this.configManager.updateIgnoreFolders(workspace.asRelativePath(uri, false));
	}

	async checkoutFolder(uri: Uri, isRecursive: boolean=true): Promise<void>  {
		const fs = require('fs/promises');

		let success = false;
			
		if ((await createDir(uri)) &&  // 1. make folder
		    (await execCmd(`cvs add ${basename(uri.fsPath)}`, dirname(uri.fsPath))).result) { // 2. cvs add folder
				// 3. cvs update folder
				if (isRecursive){
					success = (await execCmd(`cvs update -d `, uri.fsPath)).result;
				} else {
					success = (await execCmd(`cvs update `, uri.fsPath)).result;
				}
		}
		
		if (!success) {
			window.showErrorMessage(`Failed to checkout folder: ${basename(uri.fsPath)}`);
		}
	}

	async compareRevToWorkingFile(commitData: CommitData): Promise<void> {
		await commands.executeCommand('vscode.diff',
									  commitData.resourceUri, commitData.uri,
									  `${basename(commitData.uri.fsPath)} (${commitData.revision}) <-> (working)`
									  );
	}

	async openRev(commitData: CommitData): Promise<void> {
		await commands.executeCommand('vscode.open',
									  commitData.resourceUri,
									   {},
									  `${basename(commitData.uri.fsPath)} (${commitData.revision})`
									  );
	}

	async switchFileToBranch(branchData: BranchData): Promise<void> {
		let response = await spawnCmd(`cvs update -C ${basename(branchData.uri.fsPath)}`, dirname(branchData.uri.fsPath));

		if (response.result) {
			if (branchData.branchName === 'main') {
				response = await execCmd(`cvs update -A ${basename(branchData.uri.fsPath)}`, dirname(branchData.uri.fsPath));
			} else {
				response = await execCmd(`cvs update -r ${branchData.branchName} ${basename(branchData.uri.fsPath)}`, dirname(branchData.uri.fsPath));
			}
	
		}

		if(!response.result) {
			window.showErrorMessage(`Failed to switch file: ${basename(branchData.uri.fsPath)} to branch: ${branchData.branchName}`);
		}
	}

	async switchWorkspaceToBranch(branchData: BranchData): Promise<void> {
		let response = await execCmd(`cvs update -C`, this.workspacefolder.fsPath);

		if (response.result) {
			if (branchData.branchName === 'main') {
				response = await execCmd(`cvs update -A`, this.workspacefolder.fsPath);
	
			} else {
				response = await execCmd(`cvs update -r ${branchData.branchName}`, this.workspacefolder.fsPath);
			}
		}

		if(!response.result) {
			window.showErrorMessage(`Failed to switch workspace to branch: ${branchData.branchName}`);
		}
	}

	async getCvsStatus(sourceFile: SourceFile): Promise<void> {
		await this.cvsRepository.getStatusOfFile(sourceFile);
	}

	dispose() {
		this.cvsScm.dispose();
	}
}