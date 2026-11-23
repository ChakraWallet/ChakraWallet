// Search engines of the in-app browser (Android, Settings > Search engine). The address bar sends nothing while the
// user types (no search suggestions): only the search started with Enter, or by tapping "Search ... with ...".
export const SEARCH_ENGINES = [
  { id: 'duckduckgo', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  { id: 'google', name: 'Google', url: 'https://www.google.com/search?q=' },
  { id: 'brave', name: 'Brave Search', url: 'https://search.brave.com/search?q=' },
  { id: 'startpage', name: 'Startpage', url: 'https://www.startpage.com/sp/search?query=' },
  { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q=' },
  { id: 'ecosia', name: 'Ecosia', url: 'https://www.ecosia.org/search?q=' },
];

/** The engine with this id; DuckDuckGo (the default) for a missing or unknown one. */
export const searchEngine = (id) => SEARCH_ENGINES.find((e) => e.id === id) || SEARCH_ENGINES[0];

/** Results page for `query` on the engine `id`. */
export const searchUrl = (id, query) => searchEngine(id).url + encodeURIComponent(query);
