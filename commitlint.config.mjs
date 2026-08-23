export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Kept explicit so the accepted types stay in step with the release rules:
    // feat -> minor, fix/perf -> patch, everything else -> no release.
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'chore', 'ci', 'build', 'revert']
    ]
  }
};
