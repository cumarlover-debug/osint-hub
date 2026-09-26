// Right-click menu entries. The chosen value goes to the launcher page through session storage (cleared when the
// browser closes), never through a URL, so it does not end up in history or sync.

const MENUS = [
  { id: 'selection', title: 'Search “%s” with osint-hub', contexts: ['selection'] },
  { id: 'link', title: 'Search this link with osint-hub', contexts: ['link'] },
  { id: 'image', title: 'Reverse image search with osint-hub', contexts: ['image'] },
  { id: 'page', title: 'Look up this site with osint-hub', contexts: ['page'] },
];

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    for (const m of MENUS) chrome.contextMenus.create(m);
  });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  let pending;
  if (info.menuItemId === 'selection') pending = { value: info.selectionText.trim() };
  else if (info.menuItemId === 'link') pending = { value: info.linkUrl, type: 'url' };
  else if (info.menuItemId === 'image' && /^https?:/.test(info.srcUrl ?? '')) pending = { value: info.srcUrl, type: 'image' };
  else if (info.menuItemId === 'page' && /^https?:/.test(info.pageUrl ?? '')) pending = { value: new URL(info.pageUrl).hostname.replace(/^www\./, ''), type: 'domain' };
  if (!pending?.value) return;
  await chrome.storage.session.set({ pending });
  await chrome.tabs.create({ url: chrome.runtime.getURL('launcher.html') });
});
