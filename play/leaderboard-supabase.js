/* Grim Gambit desktop: the leaderboard talks to Supabase.
   The game's leaderboard code asks for a small "db" and "user" API; this file provides both on top of Supabase,
   so the rest of the game is unchanged.
   - Each install signs in anonymously once (Supabase Anonymous Sign-Ins) and keeps that identity in local storage.
   - A player's row in the `scores` table is keyed by their anonymous user id; row-level security only lets them write their own row.
   - The top 100 is read on start, every 60 seconds, and right after the player posts a new best. */
(function () {
  var cfg = (window.GG_DESKTOP && window.GG_DESKTOP.config) || window.GG_SUPABASE || null;
  var sb = null;
  if (cfg && window.supabase && window.supabase.createClient) {
    try {
      sb = window.supabase.createClient(cfg.url, cfg.anonKey, {
        auth: { persistSession: true, autoRefreshToken: true, storageKey: 'gg-supabase-auth' },
      });
    } catch (e) { console.error('Supabase setup failed', e); sb = null; }
  }

  /* Remembered account: once a player signs in (or finishes creating an account) this PC remembers it.
     The login itself is kept by Supabase in local storage and refreshed automatically, so it survives restarts and patches.
     If that saved login is ever lost (expired after a long break, or revoked), the game must NOT quietly start a new
     anonymous identity on top of it; it waits for the player to sign back in (the launch prompt asks them). */
  var AK = 'gg-account';
  function account() { try { return JSON.parse(localStorage.getItem(AK)) || null; } catch (e) { return null; } }
  if (sb) {
    sb.auth.onAuthStateChange(function (ev, session) {
      try {
        var u = session && session.user;
        if (u && !u.is_anonymous && u.email) localStorage.setItem(AK, JSON.stringify({ email: u.email, id: u.id, at: Date.now() }));
        else if (ev === 'SIGNED_OUT' && window.GG_SIGNOUT) localStorage.removeItem(AK); /* only a sign-out the player asked for forgets it */
      } catch (e) {}
    });
  }

  /* the player's id: whoever is signed in (an account, or this PC's anonymous identity) */
  var signing = null;
  function uid() {
    if (!sb) return Promise.resolve(null);
    return sb.auth.getSession().then(function (r) {
      var s = r && r.data && r.data.session;
      if (s && s.user) return s.user.id;
      if (account()) return null; /* signed-out account: wait for the player to sign back in */
      if (!signing) signing = sb.auth.signInAnonymously().then(function (a) { signing = null; if (a.error) throw a.error; return a.data.user.id; },
        function (e) { signing = null; throw e; });
      return signing;
    }).catch(function (e) { console.error('Sign-in failed', e); return null; });
  }
  /* shared with cloud saves */
  window.GG_CLOUD = sb ? { sb: sb, uid: uid, account: account } : null;

  var listeners = [];
  function refresh(limit) {
    if (!sb) return;
    sb.from('scores').select('id,name,ng,at').order('ng', { ascending: false }).order('at', { ascending: true }).limit(limit || 100)
      .then(function (r) {
        listeners.forEach(function (l) {
          if (r.error) { l.err && l.err({ code: r.error.code || r.error.message || 'error' }); return; }
          l.cb({ docs: (r.data || []).map(function (row) { return { id: row.id, data: function () { return { name: row.name, ng: row.ng, at: row.at }; } }; }) });
        });
      });
  }

  function collection(name) {
    var q = { field: 'ng', limit: 100 };
    var api = {
      orderBy: function () { return api; },
      limit: function (n) { q.limit = n; return api; },
      onSnapshot: function (cb, err) {
        var l = { cb: cb, err: err };
        listeners.push(l);
        refresh(q.limit);
        var t = setInterval(function () { refresh(q.limit); }, 60000);
        return function () { clearInterval(t); listeners = listeners.filter(function (x) { return x !== l; }); };
      },
      doc: function (id) {
        return {
          set: function (obj) {
            return uid().then(function (me) {
              if (!me || me !== id) throw { code: 'not-signed-in' };
              return sb.from(name).upsert({ id: id, name: String(obj.name || '').slice(0, 24) || 'Nameless Company', ng: Math.max(0, Math.min(999, obj.ng | 0)), at: Math.round(+obj.at || Date.now()) });
            }).then(function (r) {
              if (r && r.error) throw { code: r.error.code || r.error.message };
              refresh(q.limit);
            });
          },
        };
      },
    };
    return api;
  }

  var db = sb ? { collection: collection } : null;
  var user = sb ? { id: uid } : null;
  window.claude = {
    use: function (what) {
      if (what === 'db') return Promise.resolve(db);
      if (what === 'user') return Promise.resolve(user);
      return Promise.resolve(null);
    },
  };
})();
