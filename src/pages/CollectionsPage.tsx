import { useMemo, useState, type FormEvent } from 'react';
import { LIBRARY_LIMITS, type Collection } from '../../shared/library.js';
import { useApp, useLibrary, useVocabulary } from '../app-context.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { Link } from '../components/Link.js';
import { PageHeader } from '../components/PageHeader.js';
import { Spinner } from '../components/Spinner.js';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, CARD, HELP, INPUT, PAGE } from '../components/ui.js';
import { ApiError } from '../lib/api-client.js';
import { count } from '../lib/format.js';
import { ROUTES, buildHref } from '../lib/router.js';

const messageOf = (error: unknown, fallback: string) => (error instanceof ApiError ? error.message : fallback);

/** Named groups of words. A word can be in several; deleting a group never deletes a word. */
export function CollectionsPage() {
  const { api, library, toasts } = useApp();
  const state = useLibrary();
  const vocabulary = useVocabulary();
  const canWrite = vocabulary.meta?.writesEnabled ?? false;

  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<Collection | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  // How many of each collection's words are in the review queue right now.
  const due = useMemo(() => new Set(vocabulary.entries.filter((entry) => entry.reviewable).map((entry) => entry.id)), [vocabulary.entries]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === '' || creating) return;
    setCreating(true);
    setError(null);
    try {
      const made = await api.createCollection(name);
      library.putCollection(made);
      setName('');
      toasts.show({ message: `Collection “${made.name}” created.` });
    } catch (cause) {
      setError(messageOf(cause, 'Could not create the collection.'));
    } finally {
      setCreating(false);
    }
  };

  const rename = async (event: FormEvent) => {
    event.preventDefault();
    if (renaming === null || renaming.name.trim() === '' || busy) return;
    setBusy(true);
    setError(null);
    try {
      library.putCollection(await api.renameCollection(renaming.id, renaming.name));
      setRenaming(null);
    } catch (cause) {
      setError(messageOf(cause, 'Could not rename the collection.'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (deleting === null) return;
    setBusy(true);
    setDialogError(null);
    try {
      await api.deleteCollection(deleting.id);
      library.removeCollection(deleting.id);
      toasts.show({ message: `Collection “${deleting.name}” deleted. Its words are still in your vocabulary.` });
      setDeleting(null);
    } catch (cause) {
      setDialogError(messageOf(cause, 'Could not delete the collection.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={PAGE}>
      <PageHeader
        title="Collections"
        description="Group words your own way: by exam, book, subject or project. A word can be in several collections."
      />

      {(state.status === 'idle' || state.status === 'loading') && (
        <p role="status" className="flex items-center gap-3 text-muted">
          <Spinner className="size-5" />
          Loading your collections…
        </p>
      )}

      {state.status === 'error' && (
        <div className={`${CARD} flex flex-col items-start gap-3 p-5`}>
          <p role="alert" className="text-sm text-bad-ink">
            {state.error}
          </p>
          <button type="button" className={BUTTON_SECONDARY} onClick={() => void library.reload()}>
            Try again
          </button>
        </div>
      )}

      {state.status === 'ready' && !state.available && (
        <p className={`${CARD} px-4 py-3 text-sm text-muted`}>
          Collections can be kept once the database has its latest update.{' '}
          <Link to={ROUTES.settings} className="font-medium text-accent hover:underline">
            See Settings
          </Link>
        </p>
      )}

      {state.status === 'ready' && state.available && (
        <div className="flex max-w-2xl flex-col gap-4">
          {canWrite && (
            <form onSubmit={(event) => void create(event)} className={`${CARD} flex flex-col gap-2 p-4 sm:flex-row sm:items-end`}>
              <div className="flex flex-1 flex-col gap-1.5">
                <label htmlFor="collection-name" className="text-sm font-medium">
                  New collection
                </label>
                <input
                  id="collection-name"
                  className={INPUT}
                  placeholder="For example: IELTS"
                  maxLength={LIBRARY_LIMITS.collectionName}
                  autoComplete="off"
                  value={name}
                  disabled={creating}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <button type="submit" className={BUTTON_PRIMARY} disabled={creating || name.trim() === ''}>
                {creating ? 'Creating…' : 'Create'}
              </button>
            </form>
          )}

          {error !== null && (
            <p role="alert" className="rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad-ink">
              {error}
            </p>
          )}

          {state.collections.length === 0 ? (
            <div className={`${CARD} p-6 text-center`}>
              <h2 className="font-serif text-2xl font-semibold">No collections yet</h2>
              <p className="mt-2 text-sm text-muted">
                Create one above, then add words to it from a word’s details in the vocabulary bank.
              </p>
            </div>
          ) : (
            <ul className={`${CARD} m-0 flex list-none flex-col divide-y divide-line p-0`}>
              {state.collections.map((collection) => {
                const dueHere = collection.wordIds.filter((id) => due.has(id)).length;
                const editing = renaming?.id === collection.id;
                return (
                  <li key={collection.id} className="flex flex-col gap-2 px-4 py-3">
                    {editing ? (
                      <form onSubmit={(event) => void rename(event)} className="flex flex-wrap items-center gap-2">
                        <label className="sr-only" htmlFor={`rename-${collection.id}`}>
                          New name for {collection.name}
                        </label>
                        <input
                          id={`rename-${collection.id}`}
                          className={`${INPUT} max-w-xs`}
                          maxLength={LIBRARY_LIMITS.collectionName}
                          autoFocus
                          autoComplete="off"
                          value={renaming.name}
                          disabled={busy}
                          onChange={(event) => setRenaming({ id: collection.id, name: event.target.value })}
                        />
                        <button type="submit" className={BUTTON_PRIMARY} disabled={busy || renaming.name.trim() === ''}>
                          Save
                        </button>
                        <button type="button" className={BUTTON_SECONDARY} disabled={busy} onClick={() => setRenaming(null)}>
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                        <Link
                          to={buildHref(ROUTES.bank, { collection: collection.id })}
                          className="text-base font-semibold underline-offset-2 hover:underline"
                        >
                          {collection.name}
                        </Link>
                        <span className="text-sm tabular-nums text-muted">
                          {count(collection.wordIds.length, 'word')}
                          {collection.wordIds.length > 0 && ` · ${dueHere} due`}
                        </span>
                      </div>
                    )}
                    {!editing && (
                      <div className="flex flex-wrap gap-2">
                        {dueHere > 0 && (
                          <Link to={buildHref(ROUTES.review, { collection: collection.id })} className={BUTTON_SECONDARY}>
                            Review the due words
                          </Link>
                        )}
                        {collection.wordIds.length > 0 && (
                          <Link to={buildHref(ROUTES.practice, { collection: collection.id })} className={BUTTON_SECONDARY}>
                            Practise
                          </Link>
                        )}
                        {canWrite && (
                          <>
                            <button
                              type="button"
                              className={BUTTON_SECONDARY}
                              aria-label={`Rename ${collection.name}`}
                              onClick={() => {
                                setError(null);
                                setRenaming({ id: collection.id, name: collection.name });
                              }}
                            >
                              Rename
                            </button>
                            <button
                              type="button"
                              className={BUTTON_SECONDARY}
                              aria-label={`Delete ${collection.name}`}
                              onClick={() => {
                                setDialogError(null);
                                setDeleting(collection);
                              }}
                            >
                              Delete
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <p className={HELP}>
            To put a word in a collection, open the word from the vocabulary bank and tick the collection. Reviewing a
            collection shows only its words that are already due; it never brings a word forward.
          </p>
        </div>
      )}

      {deleting !== null && (
        <ConfirmDialog
          title={`Delete “${deleting.name}”?`}
          confirmLabel="Delete collection"
          busy={busy}
          error={dialogError}
          onConfirm={() => void remove()}
          onCancel={() => setDeleting(null)}
        >
          Only the collection is removed.{' '}
          {deleting.wordIds.length === 0
            ? 'It has no words in it.'
            : `The ${count(deleting.wordIds.length, 'word')} in it ${deleting.wordIds.length === 1 ? 'stays' : 'stay'} in your vocabulary, with ${
                deleting.wordIds.length === 1 ? 'its' : 'their'
              } mastery and review dates unchanged.`}
        </ConfirmDialog>
      )}
    </div>
  );
}
