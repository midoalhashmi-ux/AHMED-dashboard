# Dashboard UX review

The dashboard already has the correct source split for the player:

- public channel metadata remains in `channels`;
- protected HLS URLs remain in `privateStreams`;
- Web sources retain `sourceHeaders`;
- the worker remains responsible for temporary playback URLs.

No dashboard data model or source-routing behavior was changed in this
follow-up, because those changes could invalidate the player handoff that is
already working.

Small usability improvements were added: the channel count and empty state
announce changes to assistive technology, and Escape closes the add menu and
open form cards.

## Important security note

The original dashboard contained `ADMIN_SYNC_SECRET` in browser JavaScript.
That value used to be visible to every person who could download the
dashboard. The dashboard no longer embeds it: the operator enters the Worker
key when using manual match synchronization, and it is kept only in the
browser session storage. The Worker still validates the same `x-admin-key`
header, so no Worker deployment change is required. A future server-side
Firebase admin-claim flow would remove the need for this one-time session
prompt entirely.