import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

const typescriptFiles = ['**/*.ts'];

export default tseslint.config(
  { ignores: ['coverage/**', 'dist/**', 'node_modules/**'] },
  eslint.configs.recommended,
  ...[
    ...tseslint.configs.strictTypeChecked,
    ...tseslint.configs.stylisticTypeChecked,
  ].map((config) => ({ ...config, files: typescriptFiles })),
  {
    files: typescriptFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
    },
  },
);
