// Just enough Markdown for the operating manuals: headings, lists,
// paragraphs and **bold**. Builds DOM nodes, never HTML strings.

function inline(text, parent) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  for (const part of parts) {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      const b = document.createElement('strong');
      b.textContent = part.slice(2, -2);
      parent.appendChild(b);
    } else if (part) {
      parent.appendChild(document.createTextNode(part));
    }
  }
}

export function renderMarkdown(markdown, target) {
  target.replaceChildren();
  let list = null;
  let item = null;
  let para = null;
  const close = () => {
    list = null;
    item = null;
    para = null;
  };
  for (const raw of markdown.split('\n')) {
    const line = raw.trimEnd();
    if (line.trim() === '') {
      close();
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      close();
      const h = document.createElement(`h${heading[1].length}`);
      inline(heading[2], h);
      target.appendChild(h);
      continue;
    }
    const bullet = /^(\s*)- (.*)$/.exec(line);
    const numbered = /^(\s*)\d+\. (.*)$/.exec(line);
    if (bullet || numbered) {
      const m = bullet ?? numbered;
      const nested = m[1].length >= 2;
      const tag = bullet ? 'ul' : 'ol';
      if (nested && item) {
        let sub = item.querySelector(':scope > ul');
        if (!sub) {
          sub = document.createElement('ul');
          item.appendChild(sub);
        }
        const li = document.createElement('li');
        inline(m[2], li);
        sub.appendChild(li);
        continue;
      }
      if (!list || list.tagName.toLowerCase() !== tag) {
        para = null;
        list = document.createElement(tag);
        target.appendChild(list);
      }
      item = document.createElement('li');
      inline(m[2], item);
      list.appendChild(item);
      continue;
    }
    list = null;
    item = null;
    if (!para) {
      para = document.createElement('p');
      target.appendChild(para);
    } else {
      para.appendChild(document.createTextNode(' '));
    }
    inline(line, para);
  }
}
