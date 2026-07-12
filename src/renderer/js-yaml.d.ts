declare global {
  interface BrowserYamlSerializer {
    dump(value: unknown, options?: {
      lineWidth?: number;
      noRefs?: boolean;
    }): string;
  }

  var jsyaml: BrowserYamlSerializer | undefined;
}

export {};
