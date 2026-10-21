import { extractContacts } from './comment-contacts.js';

// These are candidates from the post body, not verified Zalo accounts.
export function zaloPhones(post) {
  return extractContacts(post?.text).phones.filter(phone => /^0[35789]\d{8}$/.test(phone));
}

export const ZALO_WEB_URL = 'https://chat.zalo.me/';
