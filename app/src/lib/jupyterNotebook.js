// Tests and non-Framework consumers use the same renderer as the compiler.
// The Studio runtime bundles it through scripts/editor-runtime.mjs.
export {notebookText, parseJupyterNotebook, inspectJupyterNotebookImport, renderJupyterNotebook, renderJupyterNotebookWithFiles, jupyterImagePath} from '../../../services/observable-builder/src/jupyter-notebook.mjs';
