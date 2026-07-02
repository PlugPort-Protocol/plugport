import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-this-alias': 'off',
      'no-undef': 'off', // handled by TS
      'no-empty': 'off',
      'prefer-const': 'off',
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
      'no-control-regex': 'off',
      'no-useless-escape': 'off'
    }
  }
);
