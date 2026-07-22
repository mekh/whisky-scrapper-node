import js from '@eslint/js';
import stylisticTs from '@stylistic/eslint-plugin-ts';
import tsParser from '@typescript-eslint/parser';
import { flatConfigs } from 'eslint-plugin-import-x';
import * as espree from 'espree';
import globals from 'globals';
import { configs, plugin } from 'typescript-eslint';

export default [
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'migrations/**',
      'eslint.config.mjs',
    ],
  },
  flatConfigs.recommended,
  flatConfigs.typescript,
  {
    rules: {
      'class-methods-use-this': 'off',
      'arrow-parens': 'off',
      'no-unused-vars': 'off',
      indent: ['error', 2, {
        SwitchCase: 1,
        ignoredNodes: [
          'TSTypeParameterInstantiation',
          'TSUnionType',
          'TSIntersectionType',
          'ClassBody.body > PropertyDefinition[decorators.length>0]>Identifier',
        ],
      }],
      quotes: ['error', 'single', { avoidEscape: true }],
      semi: ['error', 'always'],
      'no-return-assign': 'error',
      'no-trailing-spaces': 'error',
      'no-multiple-empty-lines': ['error', { max: 1 }],
      'comma-dangle': ['error', {
        arrays: 'always-multiline',
        objects: 'always-multiline',
        imports: 'always-multiline',
        exports: 'always-multiline',
        functions: 'only-multiline',
      }],
      'brace-style': ['error', '1tbs', { allowSingleLine: false }],
      'eol-last': ['error', 'always'],
      'object-curly-spacing': ['error', 'always'],
      'object-curly-newline': ['error', {
        multiline: true,
        consistent: true,
      }],
      'max-len': [
        'error',
        {
          code: 80,
          ignorePattern: 'import\\s.+\\sfrom\\s.+;$',
          ignoreUrls: true,
        },
      ],
    },
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      parser: espree,
      globals: globals.browser,
    },
    rules: js.configs.recommended.rules,
  },
  {
    files: ['{src,test,scripts}/**/*.ts'],
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
        project: './tsconfig.lint.json',
      },
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    plugins: {
      '@typescript-eslint': plugin,
      '@stylistic/ts': stylisticTs,
    },
    rules: {
      ...configs.strictTypeChecked[0].rules,
      ...configs.stylisticTypeChecked[0].rules,
      '@stylistic/ts/lines-between-class-members': [
        'error',
        'always',
        { exceptAfterOverload: true },
      ],
      '@stylistic/ts/member-delimiter-style': [
        'error',
        {
          overrides: {
            interface: {
              multiline: {
                delimiter: 'semi',
                requireLast: true,
              },
            },
          },
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { ignoreRestSiblings: true },
      ],
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/unbound-method': 'error',
      '@typescript-eslint/no-invalid-void-type': 'error',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-useless-constructor': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-extraneous-class': 'off',
      '@typescript-eslint/interface-name-prefix': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/ban-ts-comment': 'error',
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'off',
      '@typescript-eslint/no-misused-spread': 'off',
      '@typescript-eslint/prefer-nullish-coalescing': 'warn',
      'import/prefer-default-export': 'off',
      'import-x/no-cycle': 'error',
      'import-x/no-dynamic-require': 'warn',
      'import-x/no-nodejs-modules': 'off',
    },
  },
];
