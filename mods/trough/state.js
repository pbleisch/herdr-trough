// The operator's state changes on one story: read, unread, done, undo and snooze. The CLI applies one
// to the stored state; the pane applies the same change to its copy at once, so the card shows the
// result on the next frame and the write lands after.
export const STATE_OPERATIONS=['read','unread','done','undo','snooze'];
export function nextState(state,operation,{at,until,actor}={}) {
  const s={...state};
  if (operation==='read') s.read_at=at;
  else if (operation==='unread') delete s.read_at;
  else if (operation==='done') { s.done_at=at; s.read_at??=at; if(actor) s.done_by=actor; else delete s.done_by; }
  else if (operation==='undo') { delete s.done_at; delete s.done_by; }
  else if (operation==='snooze') s.snoozed_until=until;
  else throw new Error('unknown state operation');
  return s;
}
