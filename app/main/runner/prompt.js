/**
 * claude 에 넘길 프롬프트. 직전 실행 이후의 사람 채팅을 앞에 붙인다
 * @param {{chatsSince?: {name: string, body: string}[], requesterName: string, body: string}} p
 */
export function buildPrompt({ chatsSince = [], requesterName, body }) {
  const request = `[요청 - ${requesterName}]\n${body}`;
  if (!chatsSince.length) return request;
  const chats = chatsSince.map((c) => `${c.name}: ${c.body}`).join('\n');
  return `[방 대화]\n${chats}\n\n${request}`;
}
