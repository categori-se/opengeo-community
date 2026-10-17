// Self-hosted editor only. Publication code is never executed here.
import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/editor/browser/coreCommands.js';
import 'monaco-editor/features/codeEditor/register.js';
import 'monaco-editor/features/find/register.js';
import 'monaco-editor/features/folding/register.js';
import 'monaco-editor/features/bracketMatching/register.js';
import 'monaco-editor/features/indentation/register.js';
import 'monaco-editor/features/linesOperations/register.js';
import 'monaco-editor/features/multicursor/register.js';
import 'monaco-editor/features/clipboard/register.js';
import 'monaco-editor/features/contextmenu/register.js';
import 'monaco-editor/features/tokenization/register.js';
import 'monaco-editor/languages/definitions/javascript/register.js';
import 'monaco-editor/languages/definitions/python/register.js';
import 'monaco-editor/languages/definitions/shell/register.js';
import 'monaco-editor/languages/definitions/html/register.js';
import 'monaco-editor/languages/definitions/css/register.js';
import 'monaco-editor/languages/definitions/yaml/register.js';
import 'monaco-editor/languages/definitions/xml/register.js';
import {conf, language} from 'monaco-editor/languages/definitions/markdown/markdown.js';
import {createTokenizationSupport} from 'monaco-editor/languages/features/json/tokenization.js';
import MarkdownIt from 'markdown-it';

monaco.languages.register({id: 'json'});
monaco.languages.setTokensProvider('json', createTokenizationSupport(true));
monaco.languages.register({id: 'markdown'});
monaco.languages.setLanguageConfiguration('markdown', conf);
monaco.languages.setMonarchTokensProvider('markdown', {...language, tokenizer: {
  ...language.tokenizer,
  root: [[/^---\s*$/, {token: 'meta', next: '@frontmatter', nextEmbedded: 'yaml'}], ...language.tokenizer.root],
  frontmatter: [[/^---\s*$/, {token: 'meta', next: '@pop', nextEmbedded: '@pop'}]]
}});
const markdown = new MarkdownIt({html: false, linkify: false});
export const renderMarkdown = source => markdown.render(source);
export {renderJupyterNotebook, renderJupyterNotebookWithFiles} from '../../services/observable-builder/src/jupyter-notebook.mjs';
export {monaco};
