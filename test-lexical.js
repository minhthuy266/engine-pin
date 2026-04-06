const cheerio = require('cheerio');

// --- Copy the converter functions ---
function applyFormat(nodes, formatBit) {
    return nodes.map(node => {
        if (node.type === 'text') {
            return { ...node, format: (node.format || 0) | formatBit };
        } else if (node.type === 'link') {
            return { ...node, children: applyFormat(node.children, formatBit) };
        }
        return node;
    });
}

function inlineChildrenToLexical($, $el) {
    const children = [];
    $el.contents().each((_, node) => {
        if (node.type === 'text') {
            const text = $(node).text();
            if (text) {
                children.push({
                    type: 'text', detail: 0, format: 0, mode: 'normal',
                    style: '', text: text, version: 1
                });
            }
        } else if (node.type === 'tag') {
            const tag = node.tagName.toLowerCase();
            if (tag === 'strong' || tag === 'b') {
                children.push(...applyFormat(inlineChildrenToLexical($, $(node)), 1));
            } else if (tag === 'em' || tag === 'i') {
                children.push(...applyFormat(inlineChildrenToLexical($, $(node)), 2));
            } else if (tag === 'a') {
                children.push({
                    type: 'link',
                    children: inlineChildrenToLexical($, $(node)),
                    direction: 'ltr', format: '', indent: 0,
                    rel: $(node).attr('rel') || null,
                    target: $(node).attr('target') || null,
                    title: $(node).attr('title') || null,
                    url: $(node).attr('href') || '',
                    version: 1
                });
            } else if (tag === 'br') {
                children.push({ type: 'linebreak', version: 1 });
            } else {
                children.push(...inlineChildrenToLexical($, $(node)));
            }
        }
    });
    return children;
}

function elementToLexicalNode($, el) {
    const tag = el.tagName?.toLowerCase();
    if (!tag) return null;
    const $el = $(el);
    switch (tag) {
        case 'h1': case 'h2': case 'h3':
        case 'h4': case 'h5': case 'h6': {
            const tc = inlineChildrenToLexical($, $el);
            if (tc.length === 0) return null;
            return { type: 'heading', children: tc, direction: 'ltr', format: '', indent: 0, tag, version: 1 };
        }
        case 'p': {
            const tc = inlineChildrenToLexical($, $el);
            if (tc.length === 0) return null;
            return { type: 'paragraph', children: tc, direction: 'ltr', format: '', indent: 0, version: 1 };
        }
        case 'figure': {
            const img = $el.find('img');
            if (img.length) {
                const caption = $el.find('figcaption').text() || '';
                return {
                    type: 'image', version: 1,
                    src: img.attr('src') || '',
                    width: img.attr('width') ? parseInt(img.attr('width')) : null,
                    height: img.attr('height') ? parseInt(img.attr('height')) : null,
                    title: '', alt: img.attr('alt') || '',
                    caption, cardWidth: 'wide', href: ''
                };
            }
            return { type: 'html', version: 1, html: $.html(el) };
        }
        case 'ul': case 'ol': {
            const items = [];
            $el.children('li').each((_, li) => {
                items.push({
                    type: 'listitem',
                    children: inlineChildrenToLexical($, $(li)),
                    direction: 'ltr', format: '', indent: 0,
                    value: items.length + 1, version: 1
                });
            });
            if (items.length === 0) return null;
            return {
                type: 'list', children: items,
                direction: 'ltr', format: '', indent: 0,
                listType: tag === 'ul' ? 'bullet' : 'number',
                start: 1, tag, version: 1
            };
        }
        case 'blockquote': {
            const tc = inlineChildrenToLexical($, $el);
            if (tc.length === 0) return null;
            return { type: 'quote', children: tc, direction: 'ltr', format: '', indent: 0, version: 1 };
        }
        case 'hr':
            return { type: 'horizontalrule', version: 1 };
        default:
            return { type: 'html', version: 1, html: $.html(el) };
    }
}

function parseRegularSegment(html) {
    const trimmed = html.trim();
    if (!trimmed) return [];
    const $ = cheerio.load(trimmed, { decodeEntities: false });
    const nodes = [];
    $('body').children().each((_, el) => {
        const node = elementToLexicalNode($, el);
        if (node) nodes.push(node);
    });
    return nodes;
}

function htmlToLexicalChildren(html) {
    const children = [];
    const kgCardRegex = /<!--kg-card-begin:\s*html\s*-->([\s\S]*?)<!--kg-card-end:\s*html\s*-->/g;
    let lastIndex = 0;
    let match;
    while ((match = kgCardRegex.exec(html)) !== null) {
        if (match.index > lastIndex) {
            children.push(...parseRegularSegment(html.substring(lastIndex, match.index)));
        }
        const cardHtml = match[1].trim();
        if (cardHtml) {
            children.push({ type: 'html', version: 1, html: cardHtml });
        }
        lastIndex = match.index + match[0].length;
    }
    if (lastIndex < html.length) {
        children.push(...parseRegularSegment(html.substring(lastIndex)));
    }
    if (children.length === 0 && html.trim()) {
        children.push({ type: 'html', version: 1, html });
    }
    return children;
}

// --- TEST ---
const sampleHtml = `
<h1>7 Best CC Creams for Every Skin Type</h1>

<!--kg-card-begin: html-->
<div style="background:#FDFBFB;border:1px solid #F2EBEB;padding:20px 24px;margin:24px 0;border-radius:4px;">
  <p style="font-family:sans-serif;font-size:13px;font-weight:700;">Quick Picks</p>
  <ul style="margin:0;padding-left:18px;">
    <li>Product A</li>
    <li>Product B</li>
  </ul>
</div>
<!--kg-card-end: html-->

<p>This is the <strong>intro paragraph</strong> with a <a href="https://example.com">link here</a>.</p>

<figure class="kg-card kg-image-card"><img src="https://example.com/hero.webp" class="kg-image" alt="hero image"></figure>

<h2>Section One - Why CC Creams?</h2>
<p>CC creams are <em>amazing</em> for quick coverage.</p>

<!--kg-card-begin: html-->
<div style="display:flex;align-items:center;justify-content:space-between;">
  <span>Product Name</span>
  <a href="https://amazon.com" style="background:#B5838D;">Check Price</a>
</div>
<!--kg-card-end: html-->

<h2>Section Two</h2>
<ol>
  <li>Step one</li>
  <li>Step two</li>
  <li>Step three</li>
</ol>

<p>Final paragraph with <strong><em>bold italic</em></strong> text.</p>
`;

const result = htmlToLexicalChildren(sampleHtml);
console.log(`\n✅ Total blocks: ${result.length}\n`);
result.forEach((n, i) => {
    let info = '';
    if (n.type === 'heading') info = `tag=${n.tag}`;
    else if (n.type === 'image') info = `src=${n.src.substring(0, 40)}`;
    else if (n.type === 'html') info = n.html.substring(0, 60) + '...';
    else if (n.type === 'list') info = `${n.listType} (${n.children.length} items)`;
    else if (n.type === 'paragraph') {
        info = n.children.map(c => {
            if (c.type === 'text') return `"${c.text.substring(0,25)}"${c.format ? `[fmt:${c.format}]` : ''}`;
            if (c.type === 'link') return `[link:${c.url.substring(0,20)}]`;
            return `[${c.type}]`;
        }).join(' + ');
    }
    console.log(`  ${i+1}. ${n.type.toUpperCase().padEnd(12)} ${info}`);
});

console.log('\n--- Lexical JSON preview (first 500 chars) ---');
const lexicalDoc = JSON.stringify({
    root: {
        children: result,
        direction: null, format: '', indent: 0, type: 'root', version: 1
    }
});
console.log(lexicalDoc.substring(0, 500) + '...');
console.log(`\nTotal JSON size: ${lexicalDoc.length} bytes`);
