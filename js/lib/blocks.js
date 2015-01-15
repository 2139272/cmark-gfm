"use strict";

var Node = require('./node');
var unescapeString = require('./common').unescapeString;

var C_GREATERTHAN = 62;
var C_NEWLINE = 10;
var C_SPACE = 32;
var C_OPEN_BRACKET = 91;

var InlineParser = require('./inlines');

var BLOCKTAGNAME = '(?:article|header|aside|hgroup|iframe|blockquote|hr|body|li|map|button|object|canvas|ol|caption|output|col|p|colgroup|pre|dd|progress|div|section|dl|table|td|dt|tbody|embed|textarea|fieldset|tfoot|figcaption|th|figure|thead|footer|footer|tr|form|ul|h1|h2|h3|h4|h5|h6|video|script|style)';

var HTMLBLOCKOPEN = "<(?:" + BLOCKTAGNAME + "[\\s/>]" + "|" +
        "/" + BLOCKTAGNAME + "[\\s>]" + "|" + "[?!])";

var reHtmlBlockOpen = new RegExp('^' + HTMLBLOCKOPEN, 'i');

var reHrule = /^(?:(?:\* *){3,}|(?:_ *){3,}|(?:- *){3,}) *$/;

var reMaybeSpecial = /^[ #`~*+_=<>0-9-]/;

var reNonSpace = /[^ \t\n]/;

var reBulletListMarker = /^[*+-]( +|$)/;

var reOrderedListMarker = /^(\d+)([.)])( +|$)/;

var reATXHeaderMarker = /^#{1,6}(?: +|$)/;

var reCodeFence = /^`{3,}(?!.*`)|^~{3,}(?!.*~)/;

var reClosingCodeFence = /^(?:`{3,}|~{3,})(?= *$)/;

var reSetextHeaderLine = /^(?:=+|-+) *$/;

var reLineEnding = /\r\n|\n|\r/;

// Returns true if string contains only space characters.
var isBlank = function(s) {
    return !(reNonSpace.test(s));
};

var tabSpaces = ['    ', '   ', '  ', ' '];

// Convert tabs to spaces on each line using a 4-space tab stop.
var detabLine = function(text) {
    var start = 0;
    var offset;
    var lastStop = 0;

    while ((offset = text.indexOf('\t', start)) !== -1) {
        var numspaces = (offset - lastStop) % 4;
        var spaces = tabSpaces[numspaces];
        text = text.slice(0, offset) + spaces + text.slice(offset + 1);
        lastStop = offset + numspaces;
        start = lastStop;
    }

    return text;
};

// Attempt to match a regex in string s at offset offset.
// Return index of match or -1.
var matchAt = function(re, s, offset) {
    var res = s.slice(offset).match(re);
    if (res === null) {
        return -1;
    } else {
        return offset + res.index;
    }
};

// destructively trip final blank lines in an array of strings
var stripFinalBlankLines = function(lns) {
    var i = lns.length - 1;
    while (!reNonSpace.test(lns[i])) {
        lns.pop();
        i--;
    }
};

// DOC PARSER

// These are methods of a DocParser object, defined below.

// Returns true if parent block can contain child block.
var canContain = function(parent_type, child_type) {
    return ( parent_type === 'Document' ||
             parent_type === 'BlockQuote' ||
             parent_type === 'Item' ||
             (parent_type === 'List' && child_type === 'Item') );
};

// Returns true if block type can accept lines of text.
var acceptsLines = function(block_type) {
    return ( block_type === 'Paragraph' ||
             block_type === 'CodeBlock' );
};

// Returns true if block ends with a blank line, descending if needed
// into lists and sublists.
var endsWithBlankLine = function(block) {
    while (block) {
        if (block.last_line_blank) {
            return true;
        }
        var t = block.getType();
        if (t === 'List' || t === 'Item') {
            block = block.lastChild;
        } else {
            break;
        }
    }
    return false;
};

// Break out of all containing lists, resetting the tip of the
// document to the parent of the highest list, and finalizing
// all the lists.  (This is used to implement the "two blank lines
// break of of all lists" feature.)
var breakOutOfLists = function(block) {
    var b = block;
    var last_list = null;
    do {
        if (b.getType() === 'List') {
            last_list = b;
        }
        b = b.parent;
    } while (b);

    if (last_list) {
        while (block !== last_list) {
            this.finalize(block, this.lineNumber);
            block = block.parent;
        }
        this.finalize(last_list, this.lineNumber);
        this.tip = last_list.parent;
    }
};

// Add a line to the block at the tip.  We assume the tip
// can accept lines -- that check should be done before calling this.
var addLine = function(ln, offset) {
    var s = ln.slice(offset);
    if (!(this.tip.open)) {
        throw { msg: "Attempted to add line (" + ln + ") to closed container." };
    }
    this.tip.strings.push(s);
};

// Add block of type tag as a child of the tip.  If the tip can't
// accept children, close and finalize it and try its parent,
// and so on til we find a block that can accept children.
var addChild = function(tag, offset) {
    while (!canContain(this.tip.getType(), tag)) {
        this.finalize(this.tip, this.lineNumber - 1);
    }

    var column_number = offset + 1; // offset 0 = column 1
    var newBlock = new Node(tag, [[this.lineNumber, column_number], [0, 0]]);
    newBlock.strings = [];
    newBlock.string_content = null;
    this.tip.appendChild(newBlock);
    this.tip = newBlock;
    return newBlock;
};

// Parse a list marker and return data on the marker (type,
// start, delimiter, bullet character, padding) or null.
var parseListMarker = function(ln, offset, indent) {
    var rest = ln.slice(offset);
    var match;
    var spaces_after_marker;
    var data = { type: null,
                 tight: true,
                 bullet_char: null,
                 start: null,
                 delimiter: null,
                 padding: null,
                 marker_offset: indent };
    if (rest.match(reHrule)) {
        return null;
    }
    if ((match = rest.match(reBulletListMarker))) {
        spaces_after_marker = match[1].length;
        data.type = 'Bullet';
        data.bullet_char = match[0][0];

    } else if ((match = rest.match(reOrderedListMarker))) {
        spaces_after_marker = match[3].length;
        data.type = 'Ordered';
        data.start = parseInt(match[1]);
        data.delimiter = match[2];
    } else {
        return null;
    }
    var blank_item = match[0].length === rest.length;
    if (spaces_after_marker >= 5 ||
        spaces_after_marker < 1 ||
        blank_item) {
        data.padding = match[0].length - spaces_after_marker + 1;
    } else {
        data.padding = match[0].length;
    }
    return data;
};

// Returns true if the two list items are of the same type,
// with the same delimiter and bullet character.  This is used
// in agglomerating list items into lists.
var listsMatch = function(list_data, item_data) {
    return (list_data.type === item_data.type &&
            list_data.delimiter === item_data.delimiter &&
            list_data.bullet_char === item_data.bullet_char);
};

// Finalize and close any unmatched blocks. Returns true.
var closeUnmatchedBlocks = function() {
    // finalize any blocks not matched
    while (this.oldtip !== this.lastMatchedContainer) {
        var parent = this.oldtip.parent;
        this.finalize(this.oldtip, this.lineNumber - 1);
        this.oldtip = parent;
    }
    return true;
};

// Analyze a line of text and update the document appropriately.
// We parse markdown text by calling this on each line of input,
// then finalizing the document.
var incorporateLine = function(ln) {
    var all_matched = true;
    var first_nonspace;
    var offset = 0;
    var match;
    var data;
    var blank;
    var indent;
    var i;
    var CODE_INDENT = 4;
    var allClosed;

    var container = this.doc;
    this.oldtip = this.tip;

    // replace NUL characters for security
    if (ln.indexOf('\u0000') !== -1) {
        ln = ln.replace(/\0/g, '\uFFFD');
    }

    // Convert tabs to spaces:
    ln = detabLine(ln);

    // For each containing block, try to parse the associated line start.
    // Bail out on failure: container will point to the last matching block.
    // Set all_matched to false if not all containers match.
    while (container.lastChild) {
        if (!container.lastChild.open) {
            break;
        }
        container = container.lastChild;

        match = matchAt(reNonSpace, ln, offset);
        if (match === -1) {
            first_nonspace = ln.length;
            blank = true;
        } else {
            first_nonspace = match;
            blank = false;
        }
        indent = first_nonspace - offset;

        switch (container.getType()) {
        case 'BlockQuote':
            if (indent <= 3 && ln.charCodeAt(first_nonspace) === C_GREATERTHAN) {
                offset = first_nonspace + 1;
                if (ln.charCodeAt(offset) === C_SPACE) {
                    offset++;
                }
            } else {
                all_matched = false;
            }
            break;

        case 'Item':
            if (indent >= container.list_data.marker_offset +
                container.list_data.padding) {
                offset += container.list_data.marker_offset +
                    container.list_data.padding;
            } else if (blank) {
                offset = first_nonspace;
            } else {
                all_matched = false;
            }
            break;

        case 'Header':
        case 'HorizontalRule':
            // a header can never container > 1 line, so fail to match:
            all_matched = false;
            if (blank) {
                container.last_line_blank = true;
            }
            break;

        case 'CodeBlock':
            if (container.fence_length > 0) { // fenced
                // skip optional spaces of fence offset
                i = container.fence_offset;
                while (i > 0 && ln.charCodeAt(offset) === C_SPACE) {
                    offset++;
                    i--;
                }
            } else { // indented
                if (indent >= CODE_INDENT) {
                    offset += CODE_INDENT;
                } else if (blank) {
                    offset = first_nonspace;
                } else {
                    all_matched = false;
                }
            }
            break;

        case 'HtmlBlock':
            if (blank) {
                container.last_line_blank = true;
                all_matched = false;
            }
            break;

        case 'Paragraph':
            if (blank) {
                container.last_line_blank = true;
                all_matched = false;
            }
            break;

        default:
        }

        if (!all_matched) {
            container = container.parent; // back up to last matching block
            break;
        }
    }

    allClosed = (container === this.oldtip);
    this.lastMatchedContainer = container;

    // Check to see if we've hit 2nd blank line; if so break out of list:
    if (blank && container.last_line_blank) {
        this.breakOutOfLists(container);
    }

    // Unless last matched container is a code block, try new container starts,
    // adding children to the last matched container:
    var t = container.getType();
    while (t !== 'CodeBlock' && t !== 'HtmlBlock' &&
           // this is a little performance optimization:
           matchAt(reMaybeSpecial, ln, offset) !== -1) {

        match = matchAt(reNonSpace, ln, offset);
        if (match === -1) {
            first_nonspace = ln.length;
            blank = true;
            break;
        } else {
            first_nonspace = match;
            blank = false;
        }
        indent = first_nonspace - offset;

        if (indent >= CODE_INDENT) {
            // indented code
            if (this.tip.getType() !== 'Paragraph' && !blank) {
                offset += CODE_INDENT;
                allClosed = allClosed ||
                    this.closeUnmatchedBlocks();
                container = this.addChild('CodeBlock', offset);
            }
            break;
        }

        offset = first_nonspace;

        var cc = ln.charCodeAt(offset);

        if (cc === C_GREATERTHAN) {
            // blockquote
            offset += 1;
            // optional following space
            if (ln.charCodeAt(offset) === C_SPACE) {
                offset++;
            }
            allClosed = allClosed || this.closeUnmatchedBlocks();
            container = this.addChild('BlockQuote', first_nonspace);

        } else if ((match = ln.slice(offset).match(reATXHeaderMarker))) {
            // ATX header
            offset += match[0].length;
            allClosed = allClosed || this.closeUnmatchedBlocks();
            container = this.addChild('Header', first_nonspace);
            container.level = match[0].trim().length; // number of #s
            // remove trailing ###s:
            container.strings =
                [ln.slice(offset).replace(/^ *#+ *$/, '').replace(/ +#+ *$/, '')];
            break;

        } else if ((match = ln.slice(offset).match(reCodeFence))) {
            // fenced code block
            var fence_length = match[0].length;
            allClosed = allClosed || this.closeUnmatchedBlocks();
            container = this.addChild('CodeBlock', first_nonspace);
            container.fence_length = fence_length;
            container.fence_char = match[0][0];
            container.fence_offset = indent;
            offset += fence_length;
            break;

        } else if (matchAt(reHtmlBlockOpen, ln, offset) !== -1) {
            // html block
            allClosed = allClosed || this.closeUnmatchedBlocks();
            container = this.addChild('HtmlBlock', offset);
            offset -= indent; // back up so spaces are part of block
            break;

        } else if (container.getType() === 'Paragraph' &&
                   container.strings.length === 1 &&
                   ((match = ln.slice(offset).match(reSetextHeaderLine)))) {
            // setext header line
            allClosed = allClosed || this.closeUnmatchedBlocks();
            container.setType('Header'); // convert Paragraph to SetextHeader
            container.level = match[0][0] === '=' ? 1 : 2;
            offset = ln.length;
            break;

        } else if (matchAt(reHrule, ln, offset) !== -1) {
            // hrule
            allClosed = allClosed || this.closeUnmatchedBlocks();
            container = this.addChild('HorizontalRule', first_nonspace);
            offset = ln.length - 1;
            break;

        } else if ((data = parseListMarker(ln, offset, indent))) {
            // list item
            allClosed = allClosed || this.closeUnmatchedBlocks();
            offset += data.padding;

            // add the list if needed
            if (container.getType() !== 'List' ||
                !(listsMatch(container.list_data, data))) {
                container = this.addChild('List', first_nonspace);
                container.list_data = data;
            }

            // add the list item
            container = this.addChild('Item', first_nonspace);
            container.list_data = data;

        } else {
            break;

        }

    }

    // What remains at the offset is a text line.  Add the text to the
    // appropriate container.

    match = matchAt(reNonSpace, ln, offset);
    if (match === -1) {
        first_nonspace = ln.length;
        blank = true;
    } else {
        first_nonspace = match;
        blank = false;
    }
    indent = first_nonspace - offset;

    // First check for a lazy paragraph continuation:
    if (!allClosed && !blank &&
        this.tip.getType() === 'Paragraph' &&
        this.tip.strings.length > 0) {
        // lazy paragraph continuation

        this.last_line_blank = false;
        this.addLine(ln, offset);

    } else { // not a lazy continuation

        // finalize any blocks not matched
        allClosed = allClosed || this.closeUnmatchedBlocks();

        // Block quote lines are never blank as they start with >
        // and we don't count blanks in fenced code for purposes of tight/loose
        // lists or breaking out of lists.  We also don't set last_line_blank
        // on an empty list item.
        var t = container.getType();
        container.last_line_blank = blank &&
            !(t === 'BlockQuote' ||
              t === 'Header' ||
              (t === 'CodeBlock' && container.fence_length > 0) ||
              (t === 'Item' &&
               !container.firstChild &&
               container.sourcepos[0][0] === this.lineNumber));

        var cont = container;
        while (cont.parent) {
            cont.parent.last_line_blank = false;
            cont = cont.parent;
        }

        switch (container.getType()) {
        case 'HtmlBlock':
            this.addLine(ln, offset);
            break;

        case 'CodeBlock':
            if (container.fence_length > 0) { // fenced
                // check for closing code fence:
                match = (indent <= 3 &&
                         ln.charAt(first_nonspace) === container.fence_char &&
                         ln.slice(first_nonspace).match(reClosingCodeFence));
                if (match && match[0].length >= container.fence_length) {
                    // don't add closing fence to container; instead, close it:
                    this.finalize(container, this.lineNumber);
                } else {
                    this.addLine(ln, offset);
                }
            } else { // indented
                this.addLine(ln, offset);
            }
            break;

        case 'Header':
        case 'HorizontalRule':
            // nothing to do; we already added the contents.
            break;

        default:
            if (acceptsLines(container.getType())) {
                this.addLine(ln, first_nonspace);
            } else if (blank) {
                break;
            } else {
                // create paragraph container for line
                container = this.addChild('Paragraph', this.lineNumber, first_nonspace);
                this.addLine(ln, first_nonspace);
            }
        }
    }
    this.lastLineLength = ln.length - 1; // -1 for newline
};

// Finalize a block.  Close it and do any necessary postprocessing,
// e.g. creating string_content from strings, setting the 'tight'
// or 'loose' status of a list, and parsing the beginnings
// of paragraphs for reference definitions.  Reset the tip to the
// parent of the closed block.
var finalize = function(block, lineNumber) {
    var pos;
    var above = block.parent || this.top;
    // don't do anything if the block is already closed
    if (!block.open) {
        return 0;
    }
    block.open = false;
    block.sourcepos[1] = [lineNumber, this.lastLineLength + 1];

    switch (block.getType()) {
    case 'Paragraph':
        block.string_content = block.strings.join('\n');

        // try parsing the beginning as link reference definitions:
        while (block.string_content.charCodeAt(0) === C_OPEN_BRACKET &&
               (pos = this.inlineParser.parseReference(block.string_content,
                                                       this.refmap))) {
            block.string_content = block.string_content.slice(pos);
            if (isBlank(block.string_content)) {
                block.unlink();
                break;
            }
        }
        break;

    case 'Header':
        block.string_content = block.strings.join('\n');
        break;

    case 'HtmlBlock':
        block.literal = block.strings.join('\n');
        break;

    case 'CodeBlock':
        if (block.fence_length > 0) { // fenced
            // first line becomes info string
            block.info = unescapeString(block.strings[0].trim());
            if (block.strings.length === 1) {
                block.literal = '';
            } else {
                block.literal = block.strings.slice(1).join('\n') + '\n';
            }
        } else { // indented
            stripFinalBlankLines(block.strings);
            block.literal = block.strings.join('\n') + '\n';
        }
        break;

    case 'List':
        block.list_data.tight = true; // tight by default

        var item = block.firstChild;
        while (item) {
            // check for non-final list item ending with blank line:
            if (endsWithBlankLine(item) && item.next) {
                block.list_data.tight = false;
                break;
            }
            // recurse into children of list item, to see if there are
            // spaces between any of them:
            var subitem = item.firstChild;
            while (subitem) {
                if (endsWithBlankLine(subitem) && (item.next || subitem.next)) {
                    block.list_data.tight = false;
                    break;
                }
                subitem = subitem.next;
            }
            item = item.next;
        }
        break;

    default:
        break;
    }

    this.tip = above;
};

// Walk through a block & children recursively, parsing string content
// into inline content where appropriate.  Returns new object.
var processInlines = function(block) {
    var node, event, t;
    var walker = block.walker();
    while ((event = walker.next())) {
        node = event.node;
        t = node.getType();
        if (!event.entering && (t === 'Paragraph' || t === 'Header')) {
            this.inlineParser.parse(node, this.refmap);
        }
    }
};

var Document = function() {
    var doc = new Node('Document', [[1, 1], [0, 0]]);
    doc.string_content = null;
    doc.strings = [];
    return doc;
};

// The main parsing function.  Returns a parsed document AST.
var parse = function(input) {
    this.doc = new Document();
    this.tip = this.doc;
    this.refmap = {};
    if (this.options.time) { console.time("preparing input"); }
    var lines = input.split(reLineEnding);
    var len = lines.length;
    if (input.charCodeAt(input.length - 1) === C_NEWLINE) {
        // ignore last blank line created by final newline
        len -= 1;
    }
    if (this.options.time) { console.timeEnd("preparing input"); }
    if (this.options.time) { console.time("block parsing"); }
    for (var i = 0; i < len; i++) {
        this.lineNumber += 1;
        this.incorporateLine(lines[i]);
    }
    while (this.tip) {
        this.finalize(this.tip, len);
    }
    if (this.options.time) { console.timeEnd("block parsing"); }
    if (this.options.time) { console.time("inline parsing"); }
    this.processInlines(this.doc);
    if (this.options.time) { console.timeEnd("inline parsing"); }
    return this.doc;
};


// The DocParser object.
function DocParser(options){
    return {
        doc: new Document(),
        tip: this.doc,
        oldtip: this.doc,
        lineNumber: 0,
        lastMatchedContainer: this.doc,
        refmap: {},
        lastLineLength: 0,
        inlineParser: new InlineParser(),
        breakOutOfLists: breakOutOfLists,
        addLine: addLine,
        addChild: addChild,
        incorporateLine: incorporateLine,
        finalize: finalize,
        processInlines: processInlines,
        closeUnmatchedBlocks: closeUnmatchedBlocks,
        parse: parse,
        options: options || {}
    };
}

module.exports = DocParser;
