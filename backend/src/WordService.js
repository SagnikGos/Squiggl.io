// src/WordService.js
const WORDS = ["apple","banana","cat","dog","elephant"];
export default class WordService {
  static random() {
    return WORDS[Math.floor(Math.random() * WORDS.length)];
  }
}