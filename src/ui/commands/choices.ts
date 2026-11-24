export interface Choice {
  id: string;
  label: string;
  search?: string;
  exact?: string;
  cwd?: string;
}

export type Picker = (
  title: string,
  choices: readonly Choice[],
  choose: (id: string) => void | boolean | Promise<void | boolean>,
  options?: { custom?: boolean },
) => Promise<boolean>;

export type View =
  | { kind: 'chat' }
  | { kind: 'coordination'; mode: 'peers' | 'task' }
  | {
      kind: 'picker';
      title: string;
      choices: Choice[];
      choose(id: string): void;
      custom?: boolean;
    }
  | {
      kind: 'page';
      title: string;
      text: string;
      /** the absolute file the title links to, when there is one. */
      link?: string;
      /** a memory note's relative path, for edit and history. */
      note?: string;
      /** Witch's own text, already styled, shown as written rather than as Markdown, which drops styling. */
      styled?: true;
    };
