/**
 * Client half of dsh-session-delete -- 多选 + 底部浮条，批量删除。
 *
 * 为什么不是"每行一个删除按钮"：一排三十个会话要删三十次，中间还要 reload 三十次。
 * 现在每行的按钮是"勾选"，选中任意多个之后由底部浮条一次性提交。
 *
 * 选中必须看得见（业主 2026-11-17：「选中没有提示，不知道选中了哪几个」）：
 *   1. 按钮本身从垃圾桶换成勾选框 —— 未选是空心方框，选中是打勾，颜色转红；
 *   2. 选中时按钮上带序号（1、2、3…），一眼看出选了第几个；
 *   3. 浮条不只报数量，直接列出标题，超长截断，鼠标悬停给全量。
 * 这三条都是为了回答同一个问题：我现在选的到底是哪几个。
 *
 * 为什么不改宿主容器：宿主只给了 `sidebar.workspaces.session.row.action` 一个挂点（每行一个），
 * 列表容器不在手里。选择状态放模块级 Map，浮条用 position:fixed 挂 <body>——
 * 跟原来的删除弹窗同一个理由：行在滚动容器里，绝对定位的子节点会被裁掉。
 *
 * 为什么前端循环而不是让后端收数组：路由只吃一个 id，改路由要动 lib 里那一大段
 * stop/registry/文件逻辑，风险不值。串行发 N 次本地请求，几十毫秒。
 *
 * 两种删除仍然分开（业主 2026-10-18 定的）：
 *   不勾"彻底删除" -> 宿主把会话目录挪进 Windows 回收站，可在资源管理器里还原，所以不问。
 *   勾上           -> 直接销毁，只在这一支问一次。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-session-delete',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // 选中的会话：id -> 标题。用 Map 而不是 Set，因为浮条要报"哪几个"。
    const picked = new Map();
    const listeners = new Set();
    const notify = () => { for (const fn of listeners) { try { fn(); } catch { /* 单个订阅者出错不影响其余 */ } } };
    const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

    // 未选：空心方框。选中：打勾方框。都是 14×14，跟原来的图标同尺寸。
    const BOX = h('svg', {
      width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': 'true',
    }, h('rect', { x: 4, y: 4, width: 16, height: 16, rx: 3 }));
    const CHECK = h('svg', {
      width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': 'true',
    },
      h('rect', { x: 4, y: 4, width: 16, height: 16, rx: 3, fill: 'rgba(247,118,142,.22)' }),
      h('path', { d: 'M8 12.5l2.6 2.6L16.5 9' })
    );

    async function sendOne(sessionId, permanent) {
      try {
        const r = await fetch('/session-delete/delete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionId, permanent: !!permanent }),
        });
        return { id: sessionId, ok: r.ok, status: r.status };
      } catch (e) {
        return { id: sessionId, ok: false, status: 0, error: String(e && e.message || e) };
      }
    }

    async function sendAll(ids, permanent) {
      const out = [];
      for (const id of ids) out.push(await sendOne(id, permanent));
      return out;
    }

    let bar = null;
    let barPermanent = false;

    function ensureBar() {
      if (bar && document.body.contains(bar)) return bar;

      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:2147482000;'
        + 'display:none;align-items:center;gap:12px;padding:9px 14px;border-radius:10px;max-width:min(760px,86vw);'
        + 'background:var(--dsh-color-surface,#171a21);border:1px solid var(--dsh-color-border,#2b3040);'
        + 'box-shadow:0 10px 30px rgba(0,0,0,.45);color:var(--dsh-color-text,#e6e9ef);'
        + 'font:13px/1.4 system-ui,-apple-system,Segoe UI,sans-serif';

      const count = document.createElement('span');
      count.style.cssText = 'font-weight:600;white-space:nowrap;color:#f7768e';

      // 选中的标题列表：截断显示，悬停给全量。
      const names = document.createElement('span');
      names.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
        + 'color:var(--dsh-color-text-secondary,#8b93a7);font-size:12.5px';

      const permLabel = document.createElement('label');
      permLabel.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;color:#f7768e;font-size:12.5px;white-space:nowrap';
      const permBox = document.createElement('input');
      permBox.type = 'checkbox';
      permBox.style.cssText = 'cursor:pointer;margin:0';
      permBox.addEventListener('change', () => { barPermanent = permBox.checked; });
      const permText = document.createElement('span');
      permText.textContent = '彻底删除';
      permLabel.appendChild(permBox);
      permLabel.appendChild(permText);

      const mk = (label, color, bg) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.style.cssText = 'padding:4px 12px;border-radius:6px;font-size:12.5px;cursor:pointer;flex:none;'
          + 'border:1px solid ' + (bg ? 'transparent' : 'var(--dsh-color-border,#2b3040)') + ';'
          + 'background:' + (bg || 'transparent') + ';color:' + (color || 'inherit');
        return b;
      };
      const del = mk('删除', '#10131a', '#f7768e');
      const clear = mk('取消', null, null);

      const refresh = () => {
        const n = picked.size;
        wrap.style.display = n > 0 ? 'flex' : 'none';
        count.textContent = '已选 ' + n + ' 个';
        const titles = [...picked.values()].map((t, i) => (i + 1) + '. ' + (t || '（无标题）'));
        names.textContent = titles.length ? titles.join('   ') : '';
        names.title = titles.join('\n');
      };
      listeners.add(refresh);

      del.addEventListener('click', async () => {
        const ids = [...picked.keys()];
        if (!ids.length) return;
        if (barPermanent) {
          const list = [...picked.values()].map((t, i) => (i + 1) + '. ' + (t || '（无标题）')).join('\n');
          const sure = window.confirm(
            '真的要彻底删除这 ' + ids.length + ' 个会话吗？\n\n' + list + '\n\n' + '目录、标题缓存、以及别处对这个会话的引用都会被清掉，不进回收站。\n\n'
            + '· 这些会话的文件将被直接销毁\n'
            + '· 不进入回收目录，界面上无法撤销，磁盘上也无法恢复\n\n'
            + '这一步没有回头路。'
          );
          if (!sure) return;
        }
        del.disabled = true;
        del.textContent = '删除中…';
        const results = await sendAll(ids, barPermanent);
        const bad = results.filter((r) => !r.ok);
        if (bad.length) {
          window.alert('删除完成：' + (results.length - bad.length) + ' 成功 / ' + bad.length + ' 失败\n'
            + bad.map((r) => r.id + ' (HTTP ' + r.status + ')').join('\n'));
        }
        picked.clear();
        barPermanent = false;
        permBox.checked = false;
        window.location.reload();
      });

      clear.addEventListener('click', () => { picked.clear(); barPermanent = false; permBox.checked = false; notify(); });

      wrap.appendChild(count);
      wrap.appendChild(names);
      wrap.appendChild(permLabel);
      wrap.appendChild(del);
      wrap.appendChild(clear);
      document.body.appendChild(wrap);
      bar = wrap;
      refresh();
      return wrap;
    }

    function DeleteAction(props) {
      const owner = props && (props.owner || props);
      const sessionId = owner && owner.sessionId;
      const displayTitle = (owner && owner.displayTitle) || '';
      if (!sessionId) return null;

      const [, force] = React.useReducer((x) => x + 1, 0);
      React.useEffect(() => subscribe(force), []);

      const on = picked.has(sessionId);
      const order = on ? [...picked.keys()].indexOf(sessionId) + 1 : 0;

      const onClick = (event) => {
        if (event && event.stopPropagation) event.stopPropagation();
        if (picked.has(sessionId)) picked.delete(sessionId); else picked.set(sessionId, displayTitle);
        ensureBar();
        notify();
      };

      const btn = h('button', {
        type: 'button',
        onClick: onClick,
        title: on ? '已选中第 ' + order + ' 个：' + (displayTitle || sessionId) + '（再点取消）' : '选中（可多选后统一删除）',
        'aria-label': on ? '已选中，点击取消' : '选中删除',
        'aria-pressed': on,
        style: {
          position: 'relative',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 22, height: 22, padding: 0, margin: '0 1px',
          background: on ? 'rgba(247,118,142,.18)' : 'transparent',
          border: 'none', borderRadius: 5,
          color: on ? '#f7768e' : 'var(--dsh-color-text-secondary, #8b93a7)',
          cursor: 'pointer', opacity: 1,
        },
        onMouseEnter: (e) => { e.currentTarget.style.color = '#f7768e'; },
        onMouseLeave: (e) => { e.currentTarget.style.color = on ? '#f7768e' : 'var(--dsh-color-text-secondary, #8b93a7)'; },
      }, on ? CHECK : BOX);

      if (!on) return btn;

      // 选中态再挂一个序号小角标：光变红还不够，得说清是第几个。
      const badge = h('span', {
        style: {
          position: 'absolute', top: -3, right: -3, minWidth: 12, height: 12, padding: '0 2px',
          borderRadius: 7, background: '#f7768e', color: '#10131a',
          fontSize: 9, lineHeight: '12px', fontWeight: 700, textAlign: 'center',
          pointerEvents: 'none',
        },
      }, String(order));

      return h('span', { style: { position: 'relative', display: 'inline-flex' } }, btn, badge);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.workspaces.session.row.action', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.row.action',
          id: 'delete',
          order: 300,
          label: () => '选择删除',
        }, DeleteAction));
      },
    };
  },
});
