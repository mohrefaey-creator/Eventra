// Catches the mistakes that slip into a hand-written, build-free codebase: unused imports and undefined names.
import globals from 'globals';

export default [
  { files: ['web/**/*.js'], languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.browser } } },
  { files: ['{server,domain,test}/**/*.{js,mjs}'], languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node } } },
  { files: ['test/e2e/*.mjs'], languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node, ...globals.browser } } },
  {
    rules: {
      'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-undef': 'error',
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-redeclare': 'error',
      'no-self-assign': 'error',
    },
  },
];
