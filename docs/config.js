// ตั้งค่าของร้าน แก้ไฟล์นี้ไฟล์เดียวเมื่อติดตั้งจริง
// ปล่อย SUPABASE_URL และ SUPABASE_ANON_KEY ว่างไว้ = โหมดทดลอง
// (ข้อมูลเก็บในเบราว์เซอร์เครื่องนี้เท่านั้น ใช้ลองหน้าตาได้ ห้ามใช้งานจริง)
//
// SUPABASE_ANON_KEY คือกุญแจสาธารณะ (anon / publishable) ใส่ในไฟล์นี้ได้
// ห้ามใส่ service_role หรือ secret key ในไฟล์นี้เด็ดขาด
window.APP_CONFIG = {
  COMPANY: 'บริษัท เฟล็กซี่ โซลูชั่น จำกัด (นครราชสีมา)',
  COMPANY_PHONE: '',        // เบอร์ร้านที่จะแสดงบนหน้าเช็คประกัน เช่น '044-000-000'
  SUPABASE_URL: '',         // เช่น 'https://abcdxyz.supabase.co'
  SUPABASE_ANON_KEY: ''     // กุญแจ anon / publishable จากหน้า Project Settings > API
};
