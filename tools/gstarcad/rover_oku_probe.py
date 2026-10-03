# -*- coding: utf-8 -*-
"""
ROVER / TOPKAPIAI - GstarCAD salt-okunur envanter sondasi (Faz A).

AMAC
    Acik olan cizimi HIC DEGISTIRMEDEN tarar, iceriginin envanterini cikarir ve
    JSON olarak diske yazar. Iki isi birden yapar:
      1) Cizimde ne var: katmanlar, varlik turleri, blok adlari, yazilar, sinirlar
      2) Bu GstarCAD surumunde pygcad API'sinin hangi isimlerinin GERCEKTEN
         calistigini raporlar (API_PROBE bolumu)

    Ikincisi en az birincisi kadar onemli: LLM'e betik urettirmeden once bu
    surumde hangi cagrilarin calistigini tahminle degil olcerek bilmemiz gerekiyor.

KULLANIM
    1. GstarCAD'i acin ve incelemek istediginiz projeyi yukleyin
    2. APPLOAD komutu -> bu dosyayi secin
    3. Komut satirina:  ROVEROKU
    4. Olusan JSON dosyasinin yolu komut satirinda yazar (varsayilan:
       kullanici klasorunuzde rover_dwg_oku.json)

GUVENLIK
    Bu betik hicbir yazma islemi yapmaz. Tum tablolar ve varliklar yalnizca
    kForRead ile acilir; hicbir setter cagrilmaz; hicbir varlik eklenmez veya
    silinmez. Cizim diske kaydedilmez.

BILEREK KACINILAN SEYLER (canli ortamda cokme kaydi olanlar)
    - COM / win32com: GstarCAD kendini Running Object Table'a koymadigi icin
      baglanma basarisiz olur ve Dispatch'e dusen kod PROGRAMIN IKINCI BIR
      KOPYASINI acip oturumu kilitler.
    - gcdbEntGet (DXF gruplari) ile nokta okumak: surec izsiz oluyor.
    - Dosyadan gelen OZNITELIKLI BLOKLARIN ozniteliklerini okumak: cast basarili
      oluyor ama oznitelik okunurken program cokuyor. Bu yuzden sonda blok
      ADLARINI sayar, ozniteliklerine DOKUNMAZ.
"""

from pygcad.core import *
from pygcad.pygrx import *

import json
import os
import traceback

# Rapora en fazla kac ornek yazi/blok/katman detayi girsin.
MAX_ORNEK = 40
# Z=0 duzlemi toleransi (float gurultusu).
TOL_Z = 1e-6


# --------------------------------------------------------------------------
# API sondasi: bir cagrinin bu surumde var olup olmadigini guvenle dener.
# Amac bir degeri okumak DEGIL, hangi ismin calistigini ogrenmek.
# --------------------------------------------------------------------------

def _dene(nesne, isimler):
    """
    Verilen metot isimlerini sirayla dener, ilk calisani (deger, isim) dondurur.
    Hicbiri calismazsa (None, None). Istisnalari yutar - sondanin gorevi
    cokmek degil, neyin calistigini raporlamak.
    """
    for isim in isimler:
        try:
            fn = getattr(nesne, isim, None)
            if fn is None:
                continue
            deger = fn()
            # Bazi cagrilar (status, deger) demeti dondurur.
            if isinstance(deger, tuple):
                if len(deger) == 2:
                    deger = deger[1]
                else:
                    continue
            if deger is not None:
                return deger, isim
        except Exception:
            continue
    return None, None


def _metin_mi(sinif_adi):
    return "Text" in sinif_adi or "MText" in sinif_adi


def _yazi_oku(ent, sinif_adi):
    """Yazi iceregini sinifa gore okur. MText farkli metot kullanir."""
    try:
        if "MText" in sinif_adi:
            deger, _ = _dene(ent, ["contents", "text"])
        else:
            deger, _ = _dene(ent, ["textString", "textStringConst"])
        return deger
    except Exception:
        return None


# --------------------------------------------------------------------------

def _envanter_cikar():
    rapor = {
        "surum_notu": "ROVER GstarCAD okuma sondasi v1",
        "api_probe": {},
        "hata": None,
        "cizim": {},
        "katmanlar": [],
        "varlik_turleri": {},
        "bloklar": {},
        "yazi_ornekleri": [],
        "sayimlar": {
            "toplam_varlik": 0,
            "okunamayan_varlik": 0,
            "z_sifir_disi": 0,
        },
        "sinirlar": None,
    }

    db = gcdbWorkingDatabase()

    # --- Katman tablosu (salt okunur) -------------------------------------
    try:
        status, lt = db.getLayerTable(GcDb.kForRead)
        if status == Gcad.eOk:
            st, it = lt.newIterator()
            if st == Gcad.eOk:
                it.start()
                while not it.done():
                    try:
                        s, rec = it.getRecord()
                        if s == Gcad.eOk and rec is not None:
                            ad, kullanilan = _dene(rec, ["getName", "name"])
                            if ad is not None:
                                rapor["katmanlar"].append(str(ad))
                                rapor["api_probe"]["katman_adi"] = kullanilan
                            rec.close()
                    except Exception:
                        pass
                    it.step()
            lt.close()
    except Exception as err:
        rapor["api_probe"]["katman_tablosu_hatasi"] = str(err)

    # --- Model space varliklari (salt okunur) -----------------------------
    status, bt = db.getBlockTable(GcDb.kForRead)
    if status != Gcad.eOk:
        rapor["hata"] = "Blok tablosu acilamadi"
        return rapor

    status, ms = bt.getAt(GCDB_MODEL_SPACE, GcDb.kForRead)
    bt.close()
    if status != Gcad.eOk:
        rapor["hata"] = "Model space acilamadi"
        return rapor

    status, it = ms.newIterator()
    if status != Gcad.eOk:
        ms.close()
        rapor["hata"] = "Iterator olusturulamadi"
        return rapor

    katman_sayac = {}
    gmin = [None, None, None]
    gmax = [None, None, None]

    it.start()
    while not it.done():
        try:
            st, ent = it.getEntity()
            if st == Gcad.eOk and ent is not None:
                rapor["sayimlar"]["toplam_varlik"] += 1

                # Sinif adi
                try:
                    sinif = ent.isA().name()
                except Exception:
                    sinif = "(bilinmeyen)"
                rapor["varlik_turleri"][sinif] = rapor["varlik_turleri"].get(sinif, 0) + 1

                # Katman adi - getter ismi surume gore degisebiliyor, sondaliyoruz
                katman, kullanilan = _dene(ent, ["layer", "getLayer", "layerName"])
                if kullanilan and "varlik_katmani" not in rapor["api_probe"]:
                    rapor["api_probe"]["varlik_katmani"] = kullanilan
                if katman is not None:
                    k = str(katman)
                    katman_sayac[k] = katman_sayac.get(k, 0) + 1

                # Sinirlar + Z duzlemi kontrolu
                try:
                    ext = GcDbExtents()
                    if ent.getGeomExtents(ext) == Gcad.eOk:
                        p1 = ext.minPoint()
                        p2 = ext.maxPoint()
                        for i, (a, b) in enumerate(
                            ((p1.x, p2.x), (p1.y, p2.y), (p1.z, p2.z))
                        ):
                            gmin[i] = a if gmin[i] is None else min(gmin[i], a)
                            gmax[i] = b if gmax[i] is None else max(gmax[i], b)
                        if abs(p1.z) > TOL_Z or abs(p2.z) > TOL_Z:
                            rapor["sayimlar"]["z_sifir_disi"] += 1
                except Exception:
                    pass

                # Yazilar - mimari cizimde olculer ve etiketler burada
                if _metin_mi(sinif) and len(rapor["yazi_ornekleri"]) < MAX_ORNEK:
                    deger = _yazi_oku(ent, sinif)
                    if deger:
                        rapor["yazi_ornekleri"].append(
                            {"sinif": sinif, "metin": str(deger)[:200]}
                        )

                # Blok referanslari - SADECE AD. Ozniteliklere DOKUNMUYORUZ:
                # dosyadan gelen oznitelikli bloklarda oznitelik okumak programi
                # cokertiyor (bilinen kayit).
                if "BlockReference" in sinif:
                    try:
                        recId = ent.blockTableRecord()
                        s2, rec = gcdbOpenObject(recId, GcDb.kForRead)
                        if s2 == Gcad.eOk and rec is not None:
                            ad, _ = _dene(rec, ["getName", "name"])
                            if ad is not None:
                                a = str(ad)
                                rapor["bloklar"][a] = rapor["bloklar"].get(a, 0) + 1
                            rec.close()
                    except Exception:
                        pass

                ent.close()
            else:
                rapor["sayimlar"]["okunamayan_varlik"] += 1
        except Exception:
            rapor["sayimlar"]["okunamayan_varlik"] += 1
        it.step()

    ms.close()

    # Katman basina varlik sayisi - hangi katmanda is var, onu gosterir
    rapor["katman_varlik_sayisi"] = dict(
        sorted(katman_sayac.items(), key=lambda kv: kv[1], reverse=True)
    )

    if gmin[0] is not None:
        rapor["sinirlar"] = {
            "min": [gmin[0], gmin[1], gmin[2]],
            "max": [gmax[0], gmax[1], gmax[2]],
            "genislik": gmax[0] - gmin[0],
            "yukseklik": gmax[1] - gmin[1],
        }

    # Cizim dosyasi adi - API ismi belirsiz, sondaliyoruz
    ad, kullanilan = _dene(db, ["originalFileName", "filename", "getFilename"])
    if ad is not None:
        rapor["cizim"]["dosya"] = str(ad)
        rapor["api_probe"]["dosya_adi"] = kullanilan

    return rapor


def _cikti_yolu():
    try:
        taban = os.path.expanduser("~")
    except Exception:
        taban = "C:\\"
    return os.path.join(taban, "rover_dwg_oku.json")


@command()
def ROVEROKU():
    """Acik cizimi salt-okunur tarar ve envanterini JSON olarak yazar."""
    try:
        gcutPrintf("\n[ROVER] Salt-okunur tarama basliyor...")
        rapor = _envanter_cikar()

        yol = _cikti_yolu()
        with open(yol, "w", encoding="utf-8") as f:
            json.dump(rapor, f, ensure_ascii=False, indent=2)

        s = rapor["sayimlar"]
        gcutPrintf("\n=== ROVER OKUMA RAPORU ===")
        gcutPrintf("\nToplam varlik      : %d" % s["toplam_varlik"])
        gcutPrintf("\nOkunamayan varlik  : %d" % s["okunamayan_varlik"])
        gcutPrintf("\nKatman sayisi      : %d" % len(rapor["katmanlar"]))
        gcutPrintf("\nFarkli varlik turu : %d" % len(rapor["varlik_turleri"]))
        gcutPrintf("\nFarkli blok        : %d" % len(rapor["bloklar"]))
        gcutPrintf("\nZ=0 disinda        : %d" % s["z_sifir_disi"])
        if rapor["sinirlar"]:
            gcutPrintf(
                "\nCizim boyutu       : %.1f x %.1f"
                % (rapor["sinirlar"]["genislik"], rapor["sinirlar"]["yukseklik"])
            )
        gcutPrintf("\n\nJSON yazildi: %s" % yol)
        gcutPrintf("\nBu dosyayi Rover'a gonderin.\n")

    except Exception:
        gcutPrintf("\n[ROVER HATA]\n%s" % traceback.format_exc())
