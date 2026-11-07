import { encodeArchive } from '../../../api/domains/markdown/service/archive-format';

const markdown = '---\ntitle: メタ情報\n---\n\n# 保存の本文\n\n日本語の内容を保存します。\n';
const text = encodeArchive(
  'f6e19329-d29b-4f89-a6d6-0c89f548fa85',
  '形式確認',
  {
    formatVersion: 1,
    nodes: [{ type: 'p', children: [{ text: '日本語の内容を保存します。', bold: true }] }],
    originalMarkdown: markdown,
  },
  markdown,
);
await Bun.write(
  `${import.meta.dir}/docling-format-input.json`,
  JSON.stringify({ markdown, text, payloadPrefix: text.split('/v2#')[1]!.slice(0, 40) }, null, 2) + '\n',
);
