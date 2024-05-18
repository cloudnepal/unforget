import React, { memo, useRef } from 'react';
import type * as t from '../common/types.js';
import { assert } from '../common/util.js';
import * as md from '../common/mdFns.js';
import * as appStore from './appStore.js';
import * as actions from './appStoreActions.jsx';
import { useClickWithoutDrag } from './hooks.jsx';
import _ from 'lodash';
import * as icons from './icons.js';
import { toHtml } from 'hast-util-to-html';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { toHast } from 'mdast-util-to-hast';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown, gfmToMarkdown } from 'mdast-util-gfm';
import { visit } from 'unist-util-visit';
import { visitParents } from 'unist-util-visit-parents';
import { newlineToBreak } from 'mdast-util-newline-to-break';

export function Notes(props: { notes: t.Note[]; readonly?: boolean; onHashLinkClick?: (hash: string) => any }) {
  // const app = appStore.use();
  return (
    <div className="notes">
      {props.notes.map(note => (
        <Note key={note.id} note={note} readonly={props.readonly} onHashLinkClick={props.onHashLinkClick} />
      ))}
    </div>
  );
}

export const Note = memo(function Note(props: {
  note: t.Note;
  readonly?: boolean;
  onHashLinkClick?: (hash: string) => any;
}) {
  // Do not modify the text here because we want the position of each element in mdast and hast to match
  // exactly the original text.
  const text = props.note.text;

  function clickCb(e: React.MouseEvent) {
    // history.pushState(null, '', `/n/${props.note.id}`);
    const elem = e.target as HTMLElement;
    const link = elem.closest('a');
    const input = elem.closest('input');
    const li = elem.closest('li');
    if (input && li && !props.readonly) {
      e.preventDefault();
      e.stopPropagation();

      const [start, end] = [Number(li.dataset.posStart), Number(li.dataset.posEnd)];
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        console.error(`Got unknown start or end position for li: ${start}, ${end}`);
        return;
      }

      // console.log('checkbox at li:', start, end);
      // console.log('text:', `<START>${text!.substring(start, end)}<END>`);

      const liText = text!.substring(start, end);
      const ulCheckboxRegExp = /^(\s*[\*+-]\s*\[)([xX ])(\].*)$/m;
      const olCheckboxRegExp = /^(\s*\d+[\.\)]\s*\[)([xX ])(\].*)$/m;
      const match = liText.match(ulCheckboxRegExp) ?? liText.match(olCheckboxRegExp);
      if (!match) {
        console.error(`LiText did not match checkbox regexp: `, liText);
        return;
      }
      const newLi = match[1] + (match[2] === ' ' ? 'x' : ' ') + match[3];

      const newText = md.insertText(text!, newLi, { start, end: start + match[0].length });
      const newNote: t.Note = { ...props.note, text: newText, modification_date: new Date().toISOString() };
      actions.saveNoteAndQuickUpdateNotes(newNote);
    } else if (link) {
      const baseURL = new URL(document.baseURI);
      const targetURL = new URL(link.href, document.baseURI);
      const isRelative = baseURL.origin === targetURL.origin;

      if (baseURL.hash !== targetURL.hash) {
        e.preventDefault();
        e.stopPropagation();
        props.onHashLinkClick?.(targetURL.hash);
      } else if (isRelative) {
        e.preventDefault();
        e.stopPropagation();
        history.pushState(null, '', link.href);
      } else {
        e.stopPropagation();
      }
    } else if (!props.readonly) {
      history.pushState(null, '', `/n/${props.note.id}`);
    }
  }

  const { onClick, onMouseDown } = useClickWithoutDrag(clickCb);

  // function inputClickCb(e: React.MouseEvent) {
  //   e.preventDefault();
  //   e.stopPropagation();
  // }

  const mdast = fromMarkdown(text ?? '', {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  newlineToBreak(mdast);
  // console.log('mdast', mdast);
  assert(mdast.type === 'root', 'hast does not have root');
  const noteIsEmpty = mdast.children.length === 0;

  // Turn the first line into a heading if it's not already a heading and it is followed by two new lines
  {
    const first = mdast.children[0];
    if (first?.type === 'paragraph' && text?.match(/^[^\r\n]+\r?\n\r?\n/g)) {
      mdast.children[0] = { type: 'heading', depth: 1, position: first.position, children: first.children };
    }
  }

  // Remove everything after thematicBreak
  {
    const i = mdast.children.findIndex(node => node.type === 'thematicBreak');
    if (i !== -1) {
      mdast.children.splice(i);
    }
  }

  const hast = toHast(mdast);
  // console.log(hast);

  visit(hast, 'element', function (node) {
    if (node.tagName === 'input') {
      node.properties['disabled'] = false;
    }
    node.properties['data-pos-start'] = node.position?.start.offset;
    node.properties['data-pos-end'] = node?.position?.end.offset;
  });

  const html = toHtml(hast);

  return (
    <div className={`note ${!props.readonly && 'clickable'}`} onMouseDown={onMouseDown} onClick={onClick}>
      {Boolean(props.note.pinned) && <img className="pin" src={icons.pinFilled} />}
      {noteIsEmpty ? (
        <div>
          <h2 className="empty">Empty note</h2>
        </div>
      ) : (
        <div dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
});
