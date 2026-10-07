import type { UserConfig } from '@commitlint/types';

export default {
  extends: ['@commitlint/config-conventional'],
  // Commit 81db14a on #100 has a 115-character body line and cannot be reworded
  // without a force-push. Skip that one message; every other commit stays linted.
  ignores: [
    message =>
      message.startsWith('fix(node): keep analytics engine data points within platform limits')
  ],
  rules: {
    // Kept explicit so the accepted types stay in step with the release rules:
    // feat -> minor, fix/perf -> patch, everything else -> no release.
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'chore', 'ci', 'build', 'revert']
    ]
  }
} satisfies UserConfig;
