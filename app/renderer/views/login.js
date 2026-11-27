import { h, button } from '../dom.js';
import { errorText } from '../format.js';

export function loginView(root, ctx, { serverUrl, notice } = {}) {
  let signup = false;
  let busy = false;

  const server = h('input', { class: 'input', value: serverUrl || 'http://localhost:4310', autocomplete: 'off' });
  const email = h('input', { class: 'input', type: 'email', placeholder: 'name@company.com', autocomplete: 'username' });
  const password = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
  const name = h('input', { class: 'input', placeholder: '채팅방에 보일 이름', autocomplete: 'off' });
  const nameField = h('label', { class: 'field', hidden: true }, h('span', { class: 'label' }, '이름'), name);
  const err = h('p', { class: 'error-text' }, notice ?? '');
  const submit = button('로그인', 'primary', null, { type: 'submit' });
  const toggle = h('button', { type: 'button', class: 'btn-text login-switch', onclick: () => { signup = !signup; sync(); } });

  const field = (label, input) => h('label', { class: 'field' }, h('span', { class: 'label' }, label), input);

  function sync() {
    nameField.hidden = !signup;
    submit.textContent = signup ? '가입하기' : '로그인';
    toggle.textContent = signup ? '이미 계정이 있어요' : '처음이에요';
    password.autocomplete = signup ? 'new-password' : 'current-password';
    err.textContent = '';
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (busy) return;
    busy = true;
    submit.disabled = true;
    err.textContent = '';
    try {
      const body = { serverUrl: server.value.trim(), email: email.value.trim(), password: password.value };
      ctx.user = signup
        ? await window.rooms.signup({ ...body, name: name.value.trim() })
        : await window.rooms.login(body);
      await ctx.go('rooms');
    } catch (ex) {
      err.textContent = errorText(ex.message);
      busy = false;
      submit.disabled = false;
    }
  }

  const form = h('form', { class: 'screen', onsubmit: onSubmit },
    h('div', { class: 'screen-scroll' },
      h('div', { class: 'col' },
        h('div', { class: 'login-head' },
          h('h1', { class: 'title' }, 'Baton'),
          h('span', { class: 'sub' }, '팀원과 같은 방에서 채팅하고, 필요할 때 Claude 에게 함께 일을 맡겨요')),
        field('서버 주소', server), field('이메일', email), field('비밀번호', password), nameField, err)),
    h('div', { class: 'screen-foot' }, h('div', { class: 'col' }, toggle, submit)));
  sync();
  err.textContent = notice ?? '';
  root.append(form);
  email.focus();
  return { ready: Promise.resolve(), destroy() {} };
}
