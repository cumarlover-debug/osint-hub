export const SITE = 'https://osinthub.pages.dev';
export const REPO = 'https://github.com/cumarlover-debug/osint-hub';

/** A pre-filled "Report a problem" issue for one tool. */
export const reportProblemUrl = (name: string, slug: string) =>
  `${REPO}/issues/new?template=report-problem.yml&title=${encodeURIComponent(`Problem: ${name}`)}&tool=${encodeURIComponent(`${SITE}/tools/${slug}`)}`;
