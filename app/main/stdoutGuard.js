// 코어는 stdout 이 통신 전용이라 console.log 가 섞이면 줄이 깨진다. 다른 모듈보다 먼저 불러야 한다
console.log = console.info = (...a) => console.error(...a);
