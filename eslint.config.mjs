import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** Modules under these paths are host-agnostic and must stay free of the `vscode` API. */
const PURE_MODULES = [
  'src/core/**/*.ts',
  'src/transcript/**/*.ts',
  'src/sessions/**/*.ts',
  'src/handoff/digest.ts',
  'src/handoff/prompt.ts',
  'src/handoff/claudeCli.ts',
  'src/handoff/handoffFile.ts',
];

export default tseslint.config(
  { ignores: ['dist/**', 'bench/dist/**', 'node_modules/**', '*.vsix'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      curly: ['error', 'multi-line'],
    },
  },
  {
    files: PURE_MODULES,
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [{ name: 'vscode', message: 'Keep this module independent of the VS Code API so it stays unit-testable.' }] },
      ],
    },
  },
);
