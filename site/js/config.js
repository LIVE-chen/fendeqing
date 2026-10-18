// 公开配置。anon key 本身是公开的，真正的访问控制由数据库 RLS + RPC 函数里的 token 校验负责。
// 两项留空时，应用自动使用浏览器本地存储（仅本机可见）。
export const CONFIG = {
  supabaseUrl: 'https://hwbalidtqdjsnshygqez.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh3YmFsaWR0cWRqc25zaHlncWV6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIzNDIxOTQsImV4cCI6MjEwNzkxODE5NH0.LcAFfbheUJoIolh7TtqpEImQzO9hqNbCU1KUMabXWfg',
};
