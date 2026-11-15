import {writeFileSync} from 'node:fs';
import {LEGAL_SECTIONS,LEGAL_UPDATED,LEGAL_SOURCES} from '../web/src/legal.js';
const text='TIEMVIO POS — GIẤY PHÉP, ĐIỀU KHOẢN VÀ MIỄN TRỪ TRÁCH NHIỆM\nCập nhật '+LEGAL_UPDATED+'\n\n'+LEGAL_SECTIONS.map(([t,p])=>t+'\n\n'+p.join('\n\n')).join('\n\n')+'\n\nNGUỒN CHÍNH THỨC\n'+LEGAL_SOURCES.map(([t,u])=>t+'\n'+u).join('\n\n')+'\n';
writeFileSync(new URL('../web/public/legal.txt',import.meta.url),text);
writeFileSync(new URL('../docs/TERMS-VI.md',import.meta.url),'# Giấy phép, điều khoản và miễn trừ trách nhiệm Tiemvio POS\n\nCập nhật '+LEGAL_UPDATED+'\n\n'+LEGAL_SECTIONS.map(([t,p])=>'## '+t+'\n\n'+p.join('\n\n')).join('\n\n')+'\n\n## Nguồn chính thức\n\n'+LEGAL_SOURCES.map(([t,u])=>'- ['+t+']('+u+')').join('\n')+'\n');
console.log('Generated legal documents: '+LEGAL_SECTIONS.length+' sections');
