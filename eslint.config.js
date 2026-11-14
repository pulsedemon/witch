import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const singleLineVariable = {
  selector:
    ':matches(VariableDeclaration, ExportNamedDeclaration[declaration.type="VariableDeclaration"], ExpressionStatement[expression.type="AssignmentExpression"])',
  lineMode: 'singleline',
};

const singleLineValidationGuard = {
  selector: 'IfStatement[alternate=null][consequent.type="ThrowStatement"]',
  lineMode: 'singleline',
};

export default defineConfig(
  { ignores: ['dist/**', '.superpowers/**', 'docs/superpowers/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    plugins: { '@stylistic': stylistic },
    rules: {
      'no-fallthrough': ['error', { allowEmptyCase: true }],
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: '*', next: '*' },
        { blankLine: 'any', prev: 'import', next: 'import' },
        {
          blankLine: 'any',
          prev: singleLineVariable,
          next: singleLineVariable,
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
      'max-lines': ['error', 1500],
    },
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
