import {Badge,Button,KeyValues} from './PanelKit.jsx';
import {removalBlockerLabel} from './website-removal-model.js';

const LABELS={domain_removal:'Alan adları ve yönlendirmeler',cron_cleanup:'Zamanlanmış görevler',sftp_key_cleanup:'Dosya aktarımı erişimi',
 database_binding_cleanup:'Veritabanı bağlantıları',runtime_cleanup:'Çalışan uygulama',unix_identity_cleanup:'Site kullanıcısı',
 file_cleanup:'Dosyalar ve dosya yöneticisi',metadata_finalization:'Site kaydı',application_cleanup:'Uygulama kayıtları'};
const STATUS={pending:'Bekliyor',running:'İşleniyor',succeeded:'Tamamlandı',blocked:'Durdu',failed:'Başarısız',removed:'Silindi'};
export default function WebsiteRemovalProgress({operation,busy,onResume,onDone}){
 const done=operation.status==='removed',failed=['failed','blocked'].includes(operation.status);
 const completed=operation.steps.filter(step=>step.status==='succeeded').length;
 const step=operation.steps.find(step=>step.status!=='succeeded');
 const automatic=operation.execution?.mode==='automatic';
 return <div aria-label="Site silme durumu" aria-live="polite">
  <p><Badge state={done?'succeeded':failed?'warning':'running'}>{done?'Site silindi':failed?'İşlem durdu':automatic?'Site siliniyor':'Silme bekliyor'}</Badge></p>
  <p>{done?'Site ve bu işlemdeki bağlı kaynaklar kaldırıldı.':failed?'Tamamlanan adımlar korunuyor. Engeli giderdikten sonra aynı işleme devam edebilirsiniz.'
    :automatic?'İşlem sunucuda devam ediyor. Bu ekranı kapatabilirsiniz.':'Yarım kalan silme işlemini tek onayla tamamlayabilirsiniz.'}</p>
  <KeyValues items={[
   ['Tamamlanan adım',`${completed} / ${operation.steps.length}`],
   ['Şu an',done?'Tamamlandı':LABELS[step?.kind]??'Kaynak durumu kontrol ediliyor'],
  ]}/>
  {step?.error?.code&&<ErrorDetail code={step.error.code}/>}
  {done?onDone&&<Button variant="primary" onClick={onDone}>Web sitelerine dön</Button>
    :(!automatic||failed)&&operation.actions.runConfirmation&&onResume&&<Button disabled={busy} onClick={onResume}>Silme işlemine devam et…</Button>}
  <details className="ws-disclosure"><summary>İşlem ayrıntıları</summary>
   <ul className="ws-step-list">{operation.steps.map(item=><li key={item.id}>
    <span>{LABELS[item.kind]??'Kaynak temizliği'}</span> <Badge state={item.status==='succeeded'?'succeeded':item.status==='running'?'running':'muted'}>{STATUS[item.status]}</Badge>
   </li>)}</ul>
   <KeyValues items={[["İşlem kimliği",operation.id],["Durum",STATUS[operation.status]]]}/>
  </details>
 </div>;
}
function ErrorDetail({code}){return <div className="ws-notice ws-notice-warn"><div><strong>Silme engeli</strong><p>{removalBlockerLabel(code)}</p></div></div>;}
