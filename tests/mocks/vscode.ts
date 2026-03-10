export const workspace = {
  createFileSystemWatcher: () => ({
    onDidChange: () => ({ dispose: () => {} }),
    onDidCreate: () => ({ dispose: () => {} }),
    onDidDelete: () => ({ dispose: () => {} }),
    dispose: () => {},
  }),
  findFiles: async () => [],
};

export const Uri = {
  file: (p: string) => ({ fsPath: p, scheme: "file" }),
};

export const RelativePattern = class {
  constructor(public base: string, public pattern: string) {}
};

export class EventEmitter {
  event = () => {};
  fire() {}
  dispose() {}
}

export const window = {
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showQuickPick: async () => undefined,
  registerWebviewViewProvider: () => ({ dispose: () => {} }),
};

export const commands = {
  registerCommand: () => ({ dispose: () => {} }),
  executeCommand: async () => undefined,
};
