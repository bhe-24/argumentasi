/**
 * Maskot Emosi Argumentasi
 * Menentukan maskot berdasarkan perolehan skor dan status penyelesaian tugas
 */
(function() {
  function resolveMascot(skor, opsi = {}) {
    const rel = opsi.relPath !== undefined ? opsi.relPath : '../';
    const auto = !!opsi.auto;
    const isTimeOut = auto && skor < 60;

    let file = 'Happy.png';
    let judul = 'Luar biasa!';
    let ket = 'Pemahamanmu sangat hebat dan mendalam.';
    let badge = 'Hebat!';
    let emosi = 'happy';

    if (isTimeOut) {
      file = 'Annoyed.png';
      judul = 'Waktu Habis!';
      ket = 'Jawaban dikumpulkan otomatis karena waktu habis.';
      badge = 'Waktu Habis';
      emosi = 'annoyed';
    } else if (skor >= 85) {
      file = 'Happy.png';
      judul = 'Luar biasa!';
      ket = 'Pemahamanmu sangat hebat dan mendalam.';
      badge = 'Hebat!';
      emosi = 'happy';
    } else if (skor >= 70) {
      file = 'Oke.png';
      judul = 'Bagus sekali!';
      ket = 'Kerja bagus! Sedikit lagi menuju sempurna.';
      badge = 'Mantap!';
      emosi = 'oke';
    } else if (skor >= 55) {
      file = 'Confused.png';
      judul = 'Cukup Baik!';
      ket = 'Masih ada yang ragu? Telaah pembahasan untuk memperkuat konsep.';
      badge = 'Perlu Teliti';
      emosi = 'confused';
    } else if (skor >= 40) {
      file = 'Sigh.png';
      judul = 'Tarik Napas Dulu!';
      ket = 'Jangan putus asa, pelajari kembali materinya ya.';
      badge = 'Perlu Latihan';
      emosi = 'sigh';
    } else {
      file = 'Sad.png';
      judul = 'Tetap Semangat!';
      ket = 'Belajar adalah proses bertahap. Coba ulangi lagi, kamu pasti bisa!';
      badge = 'Jangan Menyerah';
      emosi = 'sad';
    }

    return { file, src: rel + 'assets/mascot/' + file, judul, ket, badge, emosi };
  }

  window.getMascotData = function(skor, opsi = {}) {
    const m = resolveMascot(skor, opsi);
    const html = [
      '<div class="relative flex flex-col items-center justify-center my-2 select-none pointer-events-none">',
      '  <div class="mascot-float relative">',
      '    <img src="' + m.src + '" alt="Maskot ' + m.badge + '" class="w-24 h-24 sm:w-28 sm:h-28 object-contain drop-shadow-[0_8px_16px_rgba(0,0,0,0.28)]" draggable="false">',
      '  </div>',
      '  <div class="mascot-shadow"></div>',
      '</div>'
    ].join('');

    return { ...m, html };
  };

  window.getMascotMiniHtml = function(skor, opsi = {}) {
    const m = resolveMascot(skor, opsi);
    return '<div class="mascot-float relative inline-block select-none pointer-events-none">' +
           '<img src="' + m.src + '" alt="Maskot ' + m.badge + '" class="w-14 h-14 object-contain drop-shadow-[0_4px_8px_rgba(0,0,0,0.2)]" draggable="false">' +
           '</div>';
  };
})();
