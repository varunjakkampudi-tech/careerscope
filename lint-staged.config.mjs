// Runs on staged files only (see .husky/pre-commit). Any non-zero exit blocks the commit.
// A function config is used so web files are linted with the web workspace's own
// Next.js ESLint config, exactly as `npm run lint` does, instead of the root config.
import path from 'node:path';
import process from 'node:process';

const quote = (files) => files.map((file) => JSON.stringify(file)).join(' ');
const posix = (file) => file.split(path.sep).join('/');
const isWeb = (file) => posix(path.relative(process.cwd(), file)).startsWith('apps/web/');

export default {
  '*.{ts,tsx,js,mjs}': (files) => {
    const web = files.filter(isWeb);
    const rest = files.filter((file) => !isWeb(file));
    return [
      `prettier --write ${quote(files)}`,
      ...(rest.length ? [`eslint --fix --no-warn-ignored ${quote(rest)}`] : []),
      ...(web.length
        ? [`npm exec --workspace @careerscope/web -- eslint --fix --no-warn-ignored ${quote(web)}`]
        : []),
    ];
  },
  '*.{json,md,css}': (files) => `prettier --write ${quote(files)}`,
};
