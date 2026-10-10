// Runs in the joined-groups page, not the feed/sidebar or recommendations page.
export function extractJoinedGroups() {
  const main = document.querySelector('[role="main"], main');
  if (!main) return [];
  const groups = new Map();
  for (const anchor of main.querySelectorAll('a[href]')) {
    if (!anchor.getClientRects().length || anchor.closest('[role="navigation"],nav')) continue;
    let url;
    try { url = new URL(anchor.href); } catch { continue; }
    const match = url.pathname.match(/^\/groups\/([A-Za-z0-9._-]+)\/?$/);
    if (url.protocol !== 'https:' || !/^(?:www\.|m\.|web\.)?facebook\.com$/.test(url.hostname) || !match ||
      ['joins','feed','discover','create','notifications','your_groups'].includes(match[1].toLowerCase())) continue;
    const name = (anchor.innerText || anchor.getAttribute('aria-label') || anchor.querySelector('img')?.alt || '').trim();
    const label = /^(?:Xem nhóm|View group|Visit group|Ảnh.*|Photo.*)$/i.test(name) ? '' : name;
    const canonical = `https://www.facebook.com/groups/${match[1]}/`;
    if (!groups.has(canonical) || label && !groups.get(canonical).name) groups.set(canonical,{url:canonical,name:label.slice(0,300)});
  }
  return [...groups.values()];
}

export async function readJoinedGroups(page) {
  if (new URL(page.url()).pathname.replace(/\/$/,'') !== '/groups/joins') throw new Error('Facebook không mở được danh sách nhóm đã tham gia.');
  await page.locator('[role="main"] a[href*="/groups/"], main a[href*="/groups/"]').first().waitFor({state:'visible',timeout:15000}).catch(()=>{});
  const groups = new Map();
  let stagnant=0, limited=true;
  for (let pass=0;pass<60;pass++) {
    const before=groups.size;
    for (const group of await page.evaluate(extractJoinedGroups)) {
      const old=groups.get(group.url);
      groups.set(group.url,{...group,name:group.name || old?.name || ''});
    }
    stagnant=before===groups.size ? stagnant+1 : 0;
    if (stagnant>=5) {limited=false;break;}
    await page.evaluate(()=>{
      const main=document.querySelector('[role="main"],main');
      let node=main;
      while(node && node !== document.body) {
        if (node.scrollHeight>node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY)) {node.scrollBy(0,Math.max(600,node.clientHeight*.9));return;}
        node=node.parentElement;
      }
      window.scrollBy(0,Math.max(600,window.innerHeight*.9));
    });
    await page.waitForTimeout(1000);
  }
  return {groups:[...groups.values()],limited};
}
