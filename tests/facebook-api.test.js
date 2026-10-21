import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPostsFromGraphQLPayload,
  parseGraphQLStream,
  extractPostsFromPageScripts,
  extractGroupsFromGraphQLPayload
} from '../src/facebook-api.js';

test('extractPostsFromGraphQLPayload extracts post with exact timestamp and text', () => {
  const sampleGraphQLResponse = {
    data: {
      node: {
        __typename: 'Group',
        group_feed: {
          edges: [
            {
              node: {
                __typename: 'Story',
                post_id: '998877665544',
                creation_time: 1728551234,
                message: { text: 'Cần thiết kế website bán hàng chuẩn SEO' },
                actors: [
                  {
                    name: 'Nguyễn Văn Dev',
                    url: 'https://www.facebook.com/nguyenvandev',
                    id: '100099887766'
                  }
                ],
                attachments: [
                  {
                    media: {
                      __typename: 'Photo',
                      image: { uri: 'https://scontent.xx.fbcdn.net/v/photo.jpg' }
                    }
                  }
                ]
              }
            }
          ]
        }
      }
    }
  };

  const results = extractPostsFromGraphQLPayload(sampleGraphQLResponse, 'https://www.facebook.com/groups/seowebsitebanhang');
  assert.equal(results.length, 1);
  const p = results[0];
  assert.equal(p.id, '998877665544');
  assert.equal(p.text, 'Cần thiết kế website bán hàng chuẩn SEO');
  assert.equal(p.author, 'Nguyễn Văn Dev');
  assert.equal(p.publishedAt, '2024-10-10T09:07:14.000Z');
  assert.equal(p.url, 'https://www.facebook.com/groups/seowebsitebanhang/posts/998877665544');
  assert.equal(p.media.length, 1);
  assert.equal(p.media[0].type, 'photo');
  assert.equal(p.media[0].url, 'https://scontent.xx.fbcdn.net/v/photo.jpg');
});

test('extractPostsFromGraphQLPayload handles Comet nested comet_sections layout', () => {
  const cometResponse = {
    data: {
      viewer: {
        news_feed: {
          edges: [
            {
              node: {
                id: '1122334455',
                legacy_fbid: '1122334455',
                creation_time: 1728550000,
                comet_sections: {
                  content: {
                    story: {
                      message: { text: 'Dự án tuyển CTV lập trình bot' },
                      actors: [{ name: 'Trần Thị Lead', id: '100011112222' }]
                    }
                  }
                }
              }
            }
          ]
        }
      }
    }
  };

  const results = extractPostsFromGraphQLPayload(cometResponse, 'https://www.facebook.com/groups/thietkeweb');
  assert.equal(results.length, 1);
  assert.equal(results[0].id, '1122334455');
  assert.equal(results[0].text, 'Dự án tuyển CTV lập trình bot');
  assert.equal(results[0].author, 'Trần Thị Lead');
  assert.equal(results[0].authorUrl, 'https://www.facebook.com/profile.php?id=100011112222');
});

test('extractPostsFromPageScripts parses embedded script tags', () => {
  const scriptContent = JSON.stringify({
    require: [
      ['RelayPrefetchedStreamCache', 'next', [], [
        'feed_stream',
        {
          data: {
            node: {
              id: '88776655',
              post_id: '88776655',
              creation_time: 1728552000,
              message: { text: 'Thiết kế website trọn gói 2tr' },
              actors: [{ name: 'Admin Web', id: '123' }]
            }
          }
        }
      ]]
    ]
  });

  const posts = extractPostsFromPageScripts([scriptContent], 'https://www.facebook.com/groups/design');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].id, '88776655');
  assert.equal(posts[0].text, 'Thiết kế website trọn gói 2tr');
  assert.equal(posts[0].author, 'Admin Web');
});

test('parseGraphQLStream parses newline-separated BigPipe chunks and extracts posts', () => {
  const streamChunk = `for (;;);{"data":{"node":{"post_id":"334455","creation_time":1728553000,"message":{"text":"Post from stream 1"}}}}\n{"data":{"node":{"post_id":"334456","creation_time":1728553100,"message":{"text":"Post from stream 2"}}}}`;
  const posts = parseGraphQLStream(streamChunk, 'https://www.facebook.com/groups/stream');
  assert.equal(posts.length, 2);
  assert.equal(posts[0].id, '334455');
  assert.equal(posts[0].text, 'Post from stream 1');
  assert.equal(posts[1].id, '334456');
  assert.equal(posts[1].text, 'Post from stream 2');
});

test('extractGroupsFromGraphQLPayload extracts joined and admined groups and rejects User payloads', () => {
  const payload = {
    data: {
      viewer: {
        admined_groups: {
          edges: [
            { node: { __typename: 'Group', id: '999', name: 'Nhóm Quản Lý Của Tôi', url: 'https://www.facebook.com/groups/999/' } }
          ]
        },
        all_joined_groups: {
          edges: [
            { node: { id: '1001', name: 'Nhóm Lập Trình Python', url: 'https://www.facebook.com/groups/1001/' } },
            { node: { id: '1002', name: 'Cộng Đồng Designer', url: 'https://www.facebook.com/groups/1002/' } }
          ]
        },
        actor: {
          __typename: 'User',
          id: '100016286165453',
          name: 'Ngô Quang Huy',
          url: 'https://www.facebook.com/profile.php?id=100016286165453'
        }
      }
    }
  };
  const groups = extractGroupsFromGraphQLPayload(payload);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].name, 'Nhóm Quản Lý Của Tôi');
  assert.equal(groups[1].name, 'Nhóm Lập Trình Python');
  assert.equal(groups[2].name, 'Cộng Đồng Designer');
  assert.ok(!groups.some(g => g.name === 'Ngô Quang Huy'));
  assert.ok(!groups.some(g => g.url.includes('100016286165453')));
});
