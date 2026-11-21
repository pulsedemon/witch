import { basename } from 'node:path';
import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const singleLineStatement = {
  selector:
    ':matches(VariableDeclaration, ExportNamedDeclaration[declaration.type="VariableDeclaration"], ExpressionStatement)',
  lineMode: 'singleline',
};

const singleLineValidationGuard = {
  selector: 'IfStatement[alternate=null][consequent.type="ThrowStatement"]',
  lineMode: 'singleline',
};

const pascalCaseTsx = {
  meta: {
    type: 'suggestion',
    schema: [],
    messages: { filename: 'Use PascalCase for .tsx filenames.' },
  },
  create(context) {
    return {
      Program(node) {
        if (!/^[A-Z][A-Za-z0-9]*\.tsx$/.test(basename(context.filename)))
          context.report({ node, messageId: 'filename' });
      },
    };
  },
};

const typeDeclarations = ['TSInterfaceDeclaration', 'TSTypeAliasDeclaration'];

/** the distinct names a module exports at runtime, where undefined stands for every export with no name to read, such as `export *`, a default expression or a destructuring pattern. */
function runtimeExports(program) {
  const names = program.body.flatMap((node) => {
    if (!node.type.startsWith('Export') || node.exportKind === 'type')
      return [];

    const declared = node.declaration;

    if (node.type === 'ExportNamedDeclaration' && !declared)
      return node.specifiers
        .filter(({ exportKind }) => exportKind !== 'type')
        .map(({ exported }) => exported.name);

    if (declared?.type === 'VariableDeclaration')
      return declared.declarations.map(({ id }) => id.name);

    return typeDeclarations.includes(declared?.type)
      ? []
      : [declared?.id?.name];
  });

  // an overloaded function is exported once per signature
  return [...new Set(names)];
}

const hookFilename = {
  meta: {
    type: 'suggestion',
    schema: [],
    messages: {
      filename: 'Name this file {{hook}}.ts after the hook it exports.',
    },
  },
  create(context) {
    return {
      Program(node) {
        const [hook, ...others] = runtimeExports(node);

        if (
          !others.length &&
          /^use[A-Z0-9]/.test(hook ?? '') &&
          basename(context.filename) !== `${hook}.ts`
        )
          context.report({ node, messageId: 'filename', data: { hook } });
      },
    };
  },
};

export default defineConfig(
  { ignores: ['dist/**', '.superpowers/**', 'docs/superpowers/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    plugins: {
      witch: {
        rules: {
          'pascal-case-tsx': pascalCaseTsx,
          'hook-filename': hookFilename,
        },
      },
    },
  },
  { files: ['**/*.tsx'], rules: { 'witch/pascal-case-tsx': 'error' } },
  { files: ['**/*.ts'], rules: { 'witch/hook-filename': 'error' } },
  {
    plugins: { '@stylistic': stylistic },
    rules: {
      'no-fallthrough': ['error', { allowEmptyCase: true }],
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: '*', next: '*' },
        { blankLine: 'any', prev: 'import', next: 'import' },
        {
          blankLine: 'never',
          prev: singleLineStatement,
          next: singleLineStatement,
        },
        {
          blankLine: 'any',
          prev: singleLineValidationGuard,
          next: singleLineValidationGuard,
        },
      ],
    },
  },
  {
    files: [
      'src/**/*.{ts,tsx}',
      'test/**/*.{ts,tsx}',
      'scripts/**/*.ts',
      'vitest.config.ts',
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: [
      'src/**/*.{ts,tsx}',
      'test/**/*.{ts,tsx,mts,mjs}',
      'scripts/**/*.{ts,mjs}',
      'vitest.config.ts',
    ],
    rules: { 'max-lines': ['error', 1500] },
  },
  {
    files: ['src/ui/**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...[
          'ExportNamedDeclaration > FunctionDeclaration[id.name!=/^([A-Z]|use[A-Z])/]',
          'ExportNamedDeclaration > VariableDeclaration > VariableDeclarator[id.name!=/^([A-Z]|use[A-Z])/]',
          'ExportNamedDeclaration[exportKind="value"] > ExportSpecifier[exportKind!="type"][local.name!=/^([A-Z]|use[A-Z])/]',
        ].map((selector) => ({
          selector,
          message:
            'component files export components and hooks; move helpers and constants to a .ts module',
        })),
      ],
    },
  },
);
