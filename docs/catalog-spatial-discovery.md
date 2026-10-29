# Catalog Layer previews and cancellation

Catalog **Open map** opens the selected Layer in a temporary map. Inspection does
not create or modify a saved Project, retain another copy, or change source
custody. Adding a Layer to a Project and saving that Project remain separate,
deliberate actions.

Pending account **Open map** previews show loading status and offer **Cancel
loading**. Cancellation retires that attempt immediately and enables **Retry
map**. A late source or renderer response cannot replace a newer preview. Owned
loaders are stopped; shared Catalog reads remain available to other previews.
Retry deliberately starts another attempt using the existing Layer identity and
source/version/access checks.

Catalog previews have a view lifetime. Leaving Catalog or Layer details,
replacing search results, or closing a static-reference registration disposes
associated maps and cancels owned source/provider reads. Late responses cannot
start another render or repopulate a retired view. Sorting, regrouping and
hide/reopen retain the current preview; shared cached reads remain active until
their owning Catalog is disposed.

Browser Catalog **Review and add** also offers deliberate loading cancellation.
Cancelled or retired reads cannot open source review or add a Layer. Cancellation
does not change saved Projects, retained data, rights or source custody. It grants
no additional access and introduces no automatic provider polling.
