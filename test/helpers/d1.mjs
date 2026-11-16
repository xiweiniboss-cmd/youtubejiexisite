import {DatabaseSync} from 'node:sqlite';
// Real SQLite, not a fake successful admission: SQL predicates run unchanged.
export function sqliteD1(){
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE rate_counter(k TEXT PRIMARY KEY,n INTEGER NOT NULL DEFAULT 0,last INTEGER NOT NULL DEFAULT 0,exp INTEGER NOT NULL) WITHOUT ROWID;
 CREATE TABLE blocklist(type TEXT,value TEXT,note TEXT DEFAULT '',created_at INTEGER DEFAULT 0,PRIMARY KEY(type,value));
 CREATE TABLE parse_log(id INTEGER PRIMARY KEY,ts INTEGER,site TEXT,url TEXT,ok INTEGER,status INTEGER,reason TEXT,ip TEXT,country TEXT,region TEXT,city TEXT,device_id TEXT,ua TEXT,fp TEXT);`);
 return {db,prepare(sql){let args=[];const q={bind(...a){args=a;return q},async first(){const r=db.prepare(sql).get(...args);return r?{...r}:null},async all(){return {results:db.prepare(sql).all(...args)}},async run(){const r=db.prepare(sql).run(...args);return{success:true,meta:{changes:Number(r.changes)}}}};return q;}};
}
export function testRequest(r){if(r.headers.has('cf-connecting-ip'))return r;const h=new Headers(r.headers);h.set('cf-connecting-ip','203.0.113.11');return new Request(r,{headers:h});}
