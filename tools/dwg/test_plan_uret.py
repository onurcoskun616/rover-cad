# Mimari kat planini taklit eden test DXF'i uretir: katmanlar, duvarlar,
# OZNITELIKLI pencere/kapi bloklari, yazilar ve olculer.
import ezdxf
doc = ezdxf.new("R2010", setup=True)
doc.header["$INSUNITS"] = 4          # mm
msp = doc.modelspace()

for ad, renk in [("A-DUVAR",7),("A-PENCERE",5),("A-KAPI",3),
                 ("A-OLCU",2),("A-YAZI",1),("A-BOS",8)]:
    doc.layers.add(ad, color=renk)

# Pencere blogu + oznitelik tanimlari (ATTDEF)
blk = doc.blocks.new(name="PENCERE")
blk.add_lwpolyline([(0,0),(1200,0),(1200,100),(0,100),(0,0)])
blk.add_attdef("TIP",    dxfattribs={"insert":(0,150),"height":80})
blk.add_attdef("GENISLIK",dxfattribs={"insert":(0,250),"height":80})

kapi = doc.blocks.new(name="KAPI")
kapi.add_lwpolyline([(0,0),(900,0),(900,100),(0,100),(0,0)])
kapi.add_attdef("TIP", dxfattribs={"insert":(0,150),"height":80})

# Dis duvarlar
msp.add_lwpolyline([(0,0),(12000,0),(12000,10000),(0,10000),(0,0)],
                   close=True, dxfattribs={"layer":"A-DUVAR"})

# ON CEPHEDE 3 PENCERE - asil sinayacagimiz sey
for i, x in enumerate([2000, 5400, 8800]):
    ins = msp.add_blockref("PENCERE", (x,0), dxfattribs={"layer":"A-PENCERE"})
    ins.add_auto_attribs({"TIP": "P%d" % (i+1), "GENISLIK": "1200"})

ins = msp.add_blockref("KAPI", (5550,10000), dxfattribs={"layer":"A-KAPI"})
ins.add_auto_attribs({"TIP": "K1"})

msp.add_text("SALON", height=300, dxfattribs={"layer":"A-YAZI"}).set_placement((3000,5000))
msp.add_mtext("NORMAL KAT PLANI\nOlcek 1/50", dxfattribs={"layer":"A-YAZI"}).set_location((500,11000))

msp.add_linear_dim(base=(0,-900), p1=(0,0), p2=(12000,0),
                   dxfattribs={"layer":"A-OLCU"}).render()
msp.add_linear_dim(base=(-900,0), p1=(0,0), p2=(0,10000), angle=90,
                   dxfattribs={"layer":"A-OLCU"}).render()

doc.saveas("test_kat_plani.dxf")
print("test_kat_plani.dxf yazildi")
print("BEKLENEN -> 3 PENCERE blogu, 1 KAPI, 2 olcu, 1 TEXT + 1 MTEXT, 6 katman (1 bos), birim mm")
