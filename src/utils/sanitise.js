/* ============================================================
   Candidate-authored HTML.

   A descriptive answer is written in a rich-text box, so what the
   candidate types arrives as HTML and is stored as HTML. It is then
   rendered — with `dangerouslySetInnerHTML`, because that is what
   showing formatted text means — in the EVALUATOR's browser, inside
   the administration origin.

   That makes an answer field a way for a candidate to run script in a
   member of staff's session: `<img src=x onerror="...">` typed into
   an answer executes when the evaluator opens the script, with the
   evaluator's own session around it. Not theoretical — the editor can
   be bypassed entirely by posting to the answer endpoint directly,
   which is a single request from the candidate's own console.

   So the markup is reduced to what the editor can actually produce
   and nothing else, on the way IN. Sanitising on the way in rather
   than on the way out means a stored answer is safe for every reader
   it will ever have — the evaluator's screen, a report, an export —
   rather than safe only in the one place someone remembered.
   ============================================================ */
import sanitizeHtml from 'sanitize-html';

/* Exactly the tags the answer editor emits: bold, italic, underline,
   strikethrough, super- and subscript, colour, size, lists and the
   paragraph structure contentEditable produces. No links, no images,
   no tables, no styles beyond colour — a candidate has no reason to
   embed any of those in an answer, and each one is a way in. */
const ANSWER_HTML = {
  allowedTags: [
    'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'sub', 'sup',
    'p', 'div', 'br', 'span', 'font',
    'ul', 'ol', 'li',
  ],
  allowedAttributes: {
    font: ['color', 'size', 'face'],
    span: ['style'],
    div: ['style'],
    p: ['style'],
    li: ['style'],
  },
  allowedStyles: {
    '*': {
      color: [/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, /^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/,
             /^[a-zA-Z]{3,20}$/],
      'font-size': [/^\d{1,3}(?:px|pt|em|%)$/],
      'font-weight': [/^(?:bold|normal|\d{3})$/],
      'text-decoration': [/^(?:underline|line-through|none)$/],
      'font-style': [/^(?:italic|normal)$/],
    },
  },
  /* No URLs survive at all, so there is nothing for a scheme filter
     to get wrong. */
  allowedSchemes: [],
  allowedSchemesByTag: {},
  disallowedTagsMode: 'discard',
  enforceHtmlBoundary: true,
};

export function sanitiseAnswerHtml(html) {
  if (typeof html !== 'string' || !html) return html;
  return sanitizeHtml(html, ANSWER_HTML);
}

/* The plain-text fields are shown as HTML in the evaluator's viewer
   too, because a typed answer and a rich-text one go through the same
   element. Stripping every tag leaves the text intact and the markup
   gone. */
export function stripTags(text) {
  if (typeof text !== 'string' || !text) return text;
  return sanitizeHtml(text, { allowedTags: [], allowedAttributes: {}, allowedSchemes: [] });
}
