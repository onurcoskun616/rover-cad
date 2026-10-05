#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ROVER / TOPKAPIAI - Mimari cizim salt-okunur envanteri (Faz A).

Bir DXF (veya ODA File Converter kuruluysa DWG) dosyasini HIC DEGISTIRMEDEN
tarar ve icerigin envanterini JSON olarak cikarir.

NEDEN BU, GstarCAD/AutoCAD ICINDE CALISAN BETIK YERINE
    - Ucretsiz: ezdxf MIT lisansli, ODA File Converter ucretsiz
    - Sunucuda calisir: CAD programi, GUI, APPLOAD, kullanici basina lisans yok
    - Mevcut mimarimizle ayni sekil: Python sunucuda calisiyor (FreeCAD gibi)
    - Oznitelikli bloklari GUVENLE okur. GstarCAD'in Python API'sinde dosyadan
      gelen oznitelikli blogun ozniteligini okumak programi cokertiyordu;
      mimari cizimler (kapi/pencere/mahal etiketleri) tam da bunlarla dolu.

KULLANIM
    python rover_oku.py cizim.dxf
    python rover_oku.py cizim.dwg -o envanter.json
    python rover_oku.py cizim.dxf --yazi-limit 100

GUVENLIK
    Dosya yalnizca okunur. Hicbir kaydetme cagrisi yoktur; girdi dosyasi
    degistirilmez.
"""

import argparse
import json
import os
import sys
from collections import Counter

try:
    import ezdxf
    from ezdxf.document import Drawing
except ImportError:
    # Windows'ta siksik gorulen tuzak: makinede birden fazla Python kurulu
    # oldugunda "pip install" bir yorumlayiciya kurar, "python script.py"
    # bir digerini calistirir; paket kurulu gorunur ama import edilemez.
    # Cozum pip'i calisan yorumlayicinin KENDISI uzerinden cagirmak.
    # Hangi Python'un calistigini basarak teshisi okuyucuya biraktirmiyoruz.
    sys.stderr.write(
        "ezdxf bulunamadi.\n\n"
        "Calisan Python : %s\n"
        "Surum          : %s\n\n"
        "Kurmak icin ayni yorumlayiciyi kullanin:\n"
        '  "%s" -m pip install ezdxf\n\n'
        "(Yalnizca 'pip install ezdxf' yazmak, makinede birden fazla Python "
        "varsa paketi BASKA bir yorumlayiciya kurabilir.)\n"
        % (sys.executable, sys.version.split()[0], sys.executable)
    )
    raise SystemExit(2)


VARSAYILAN_YAZI_LIMIT = 60
VARSAYILAN_OLCU_LIMIT = 60


def dosyayi_ac(yol):
    """
    DXF'i dogrudan, DWG'yi ODA File Converter uzerinden acar.
    Donen: (Drawing, kaynak_aciklamasi)
    """
    uzanti = os.path.splitext(yol)[1].lower()

    if uzanti == ".dwg":
        try:
            from ezdxf.addons import odafc
        except ImportError:
            raise SystemExit(
                "DWG okumak icin ezdxf'in odafc eklentisi gerekiyor."
            )
        try:
            return odafc.readfile(yol), "DWG (ODA File Converter ile cevrildi)"
        except Exception as err:
            raise SystemExit(
                "DWG acilamadi: %s\n\n"
                "ODA File Converter kurulu olmayabilir (ucretsiz):\n"
                "  https://www.opendesign.com/guestfiles/oda_file_converter\n"
                "Alternatif: cizimi CAD programinizdan DXF olarak kaydedin."
                % err
            )

    return ezdxf.readfile(yol), "DXF"


def _metin_oku(e):
    """
    TEXT / MTEXT / ATTRIB iceriklerini sinifa gore okur.

    MTEXT ham hâlde bicim kodlari tasir (satir sonu \\P, yazi tipi \\f...,
    yukseklik \\H...). Bunlar LLM'e gidince gurultu olur, bu yuzden ezdxf'in
    kendi temizleyicisinden geciriyoruz.
    """
    tip = e.dxftype()
    try:
        if tip == "MTEXT":
            ham = e.text
            try:
                from ezdxf.tools.text import plain_mtext

                return plain_mtext(ham)
            except Exception:
                return ham
        if tip in ("TEXT", "ATTRIB", "ATTDEF"):
            return e.dxf.text
    except Exception:
        return None
    return None


def envanter_cikar(doc, yazi_limit, olcu_limit):
    msp = doc.modelspace()

    rapor = {
        "surum_notu": "ROVER mimari cizim envanteri v1 (ezdxf)",
        "dxf_surumu": doc.dxfversion,
        "birim": None,
        "katmanlar": [],
        "katman_varlik_sayisi": {},
        "varlik_turleri": {},
        "bloklar": {},
        "blok_oznitelikleri": {},
        "yazi_ornekleri": [],
        "olculer": [],
        "sinirlar": None,
        "sayimlar": {
            "toplam_varlik": 0,
            "okunamayan_varlik": 0,
            "blok_referansi": 0,
            "olcu": 0,
            "yazi": 0,
        },
        "uyarilar": [],
    }

    # --- Birim --------------------------------------------------------
    # $INSUNITS: 4=mm, 5=cm, 6=m. Mimari cizimde bunu bilmek sart.
    BIRIM_ADI = {0: "belirsiz", 1: "inc", 2: "fit", 4: "mm", 5: "cm", 6: "m"}
    try:
        kod = doc.header.get("$INSUNITS", 0)
        rapor["birim"] = {"kod": kod, "ad": BIRIM_ADI.get(kod, "bilinmeyen")}
        if kod == 0:
            rapor["uyarilar"].append(
                "Cizimde birim tanimli degil ($INSUNITS=0). Olculerin mm mi cm mi "
                "oldugu dosyadan anlasilamiyor; olcu metinleriyle karsilastirin."
            )
    except Exception:
        pass

    # --- Katman tablosu -----------------------------------------------
    try:
        for katman in doc.layers:
            rapor["katmanlar"].append(katman.dxf.name)
    except Exception as err:
        rapor["uyarilar"].append("Katman tablosu okunamadi: %s" % err)

    # --- Model space taramasi ------------------------------------------
    katman_sayac = Counter()
    tur_sayac = Counter()
    blok_sayac = Counter()
    oznitelik_tag = {}

    xmin = ymin = float("inf")
    xmax = ymax = float("-inf")

    for e in msp:
        try:
            rapor["sayimlar"]["toplam_varlik"] += 1
            tip = e.dxftype()
            tur_sayac[tip] += 1

            try:
                katman_sayac[e.dxf.layer] += 1
            except Exception:
                pass

            # Sinirlar: her varlik tipinin kendi yolu var, ezdxf'in
            # bbox modulu hepsini tek elden hesapliyor.
            # (Asagida toplu olarak yapiliyor - burada tek tek denemiyoruz.)

            # Blok referanslari + OZNITELIKLER (GstarCAD'de cokertici olan kisim)
            if tip == "INSERT":
                rapor["sayimlar"]["blok_referansi"] += 1
                try:
                    ad = e.dxf.name
                    blok_sayac[ad] += 1
                    for attr in e.attribs:
                        try:
                            tag = attr.dxf.tag
                            deger = attr.dxf.text
                            oznitelik_tag.setdefault(ad, {})
                            oznitelik_tag[ad].setdefault(tag, [])
                            if (
                                deger
                                and len(oznitelik_tag[ad][tag]) < 5
                                and deger not in oznitelik_tag[ad][tag]
                            ):
                                oznitelik_tag[ad][tag].append(deger)
                        except Exception:
                            pass
                except Exception:
                    pass

            # Yazilar: mimari cizimde mahal adlari, kot, aks ve notlar
            elif tip in ("TEXT", "MTEXT"):
                rapor["sayimlar"]["yazi"] += 1
                if len(rapor["yazi_ornekleri"]) < yazi_limit:
                    metin = _metin_oku(e)
                    if metin:
                        rapor["yazi_ornekleri"].append(
                            {
                                "tip": tip,
                                "katman": getattr(e.dxf, "layer", ""),
                                "metin": str(metin)[:200],
                            }
                        )

            # Olculer: gercek boyutlar burada
            elif tip == "DIMENSION":
                rapor["sayimlar"]["olcu"] += 1
                if len(rapor["olculer"]) < olcu_limit:
                    try:
                        rapor["olculer"].append(
                            {
                                "katman": getattr(e.dxf, "layer", ""),
                                "olculen": getattr(e, "get_measurement", lambda: None)(),
                                "metin": getattr(e.dxf, "text", ""),
                            }
                        )
                    except Exception:
                        pass

        except Exception:
            rapor["sayimlar"]["okunamayan_varlik"] += 1

    # --- Sinirlar (ezdxf'in kendi bbox hesabi) -------------------------
    try:
        from ezdxf import bbox

        kutu = bbox.extents(msp, fast=True)
        if kutu.has_data:
            xmin, ymin = kutu.extmin.x, kutu.extmin.y
            xmax, ymax = kutu.extmax.x, kutu.extmax.y
            rapor["sinirlar"] = {
                "min": [round(xmin, 3), round(ymin, 3)],
                "max": [round(xmax, 3), round(ymax, 3)],
                "genislik": round(xmax - xmin, 3),
                "yukseklik": round(ymax - ymin, 3),
            }
    except Exception as err:
        rapor["uyarilar"].append("Sinirlar hesaplanamadi: %s" % err)

    rapor["katman_varlik_sayisi"] = dict(katman_sayac.most_common())
    rapor["varlik_turleri"] = dict(tur_sayac.most_common())
    rapor["bloklar"] = dict(blok_sayac.most_common())
    rapor["blok_oznitelikleri"] = oznitelik_tag

    # Bos katmanlari ayirmak, hangi katmanda is oldugunu gosterir
    rapor["bos_katmanlar"] = [
        k for k in rapor["katmanlar"] if katman_sayac.get(k, 0) == 0
    ]

    return rapor


def ozet_yazdir(rapor, kaynak):
    s = rapor["sayimlar"]
    print("=== ROVER CIZIM ENVANTERI ===")
    print("Kaynak              : %s" % kaynak)
    print("DXF surumu          : %s" % rapor["dxf_surumu"])
    if rapor["birim"]:
        print("Birim               : %s" % rapor["birim"]["ad"])
    print("Toplam varlik       : %d" % s["toplam_varlik"])
    print("Okunamayan          : %d" % s["okunamayan_varlik"])
    print("Katman (toplam/bos) : %d / %d" % (len(rapor["katmanlar"]), len(rapor["bos_katmanlar"])))
    print("Varlik turu cesidi  : %d" % len(rapor["varlik_turleri"]))
    print("Farkli blok         : %d" % len(rapor["bloklar"]))
    print("Blok referansi      : %d" % s["blok_referansi"])
    print("Olcu                : %d" % s["olcu"])
    print("Yazi                : %d" % s["yazi"])
    if rapor["sinirlar"]:
        print(
            "Cizim boyutu        : %.1f x %.1f"
            % (rapor["sinirlar"]["genislik"], rapor["sinirlar"]["yukseklik"])
        )

    if rapor["varlik_turleri"]:
        print("\n-- En cok gecen varlik turleri --")
        for ad, n in list(rapor["varlik_turleri"].items())[:10]:
            print("   %-22s %d" % (ad, n))

    if rapor["katman_varlik_sayisi"]:
        print("\n-- En dolu katmanlar --")
        for ad, n in list(rapor["katman_varlik_sayisi"].items())[:10]:
            print("   %-30s %d" % (ad[:30], n))

    if rapor["bloklar"]:
        print("\n-- En cok kullanilan bloklar --")
        for ad, n in list(rapor["bloklar"].items())[:10]:
            print("   %-30s %d" % (ad[:30], n))

    for u in rapor["uyarilar"]:
        print("\n[UYARI] %s" % u)


def main():
    ap = argparse.ArgumentParser(
        description="Mimari cizimin salt-okunur envanterini cikarir (DXF/DWG)."
    )
    ap.add_argument("dosya", help="DXF veya DWG dosyasi")
    ap.add_argument("-o", "--cikti", help="JSON cikti yolu (varsayilan: <dosya>_envanter.json)")
    ap.add_argument("--yazi-limit", type=int, default=VARSAYILAN_YAZI_LIMIT)
    ap.add_argument("--olcu-limit", type=int, default=VARSAYILAN_OLCU_LIMIT)
    args = ap.parse_args()

    if not os.path.exists(args.dosya):
        raise SystemExit("Dosya bulunamadi: %s" % args.dosya)

    doc, kaynak = dosyayi_ac(args.dosya)
    rapor = envanter_cikar(doc, args.yazi_limit, args.olcu_limit)
    rapor["kaynak"] = kaynak
    rapor["dosya"] = os.path.basename(args.dosya)

    cikti = args.cikti or (os.path.splitext(args.dosya)[0] + "_envanter.json")
    with open(cikti, "w", encoding="utf-8") as f:
        json.dump(rapor, f, ensure_ascii=False, indent=2)

    ozet_yazdir(rapor, kaynak)
    print("\nJSON yazildi: %s" % cikti)


if __name__ == "__main__":
    main()
