"""Axonometric preview rendered from the real .3dm geometry."""
import rhino3dm as r3, numpy as np, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d.art3d import Poly3DCollection

f = r3.File3dm.Read("../out/RMUH_v1.3dm")
polys, cols, alphas, zs = [], [], [], []

def bbox_faces(b):
    x0,y0,z0=b.Min.X,b.Min.Y,b.Min.Z; x1,y1,z1=b.Max.X,b.Max.Y,b.Max.Z
    v=np.array([[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],
                [x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]])
    return [[v[i] for i in q] for q in
            ([0,1,2,3],[4,5,6,7],[0,1,5,4],[2,3,7,6],[1,2,6,5],[0,3,7,4])]

def srf_quads(s, n=8):
    du,dv = s.Domain(0), s.Domain(1); out=[]
    P=[[s.PointAt(du.T0+i/n*(du.T1-du.T0), dv.T0+j/n*(dv.T1-dv.T0)) for j in range(n+1)]
       for i in range(n+1)]
    for i in range(n):
        for j in range(n):
            out.append([[P[a][b].X,P[a][b].Y,P[a][b].Z]
                        for a,b in ((i,j),(i+1,j),(i+1,j+1),(i,j+1))])
    return out

for o in f.Objects:
    a=o.Attributes; L=f.Layers[a.LayerIndex]; cat=a.GetUserString("Category")
    if cat=="Site": continue
    c=np.array(L.Color[:3])/255.0
    g=o.Geometry
    if g.ObjectType==r3.ObjectType.Surface or isinstance(g,r3.NurbsSurface):
        qs=srf_quads(g)
    else:
        qs=bbox_faces(g.GetBoundingBox())
    al = 0.30 if cat=="Glazing" else 1.0
    for q in qs:
        polys.append(q); cols.append(c); alphas.append(al)
        zs.append(np.mean([p[1] for p in q]) - np.mean([p[2] for p in q])*0.6)

order=np.argsort(zs)[::-1]
fig=plt.figure(figsize=(17,9)); ax=fig.add_subplot(111,projection="3d")
for i in order:
    ax.add_collection3d(Poly3DCollection([polys[i]],facecolor=cols[i],
        edgecolor=(0.15,0.15,0.15,0.22),linewidths=0.25,alpha=alphas[i]))
allp=np.array([p for q in polys for p in q])
ax.set_xlim(allp[:,0].min(),allp[:,0].max()); ax.set_ylim(allp[:,1].min(),allp[:,1].max())
ax.set_zlim(0,allp[:,2].max())
ax.set_box_aspect((np.ptp(allp[:,0]),np.ptp(allp[:,1]),np.ptp(allp[:,2])*2.4))
ax.view_init(elev=26,azim=-58); ax.set_axis_off()
plt.tight_layout(); plt.savefig("../out/RMUH_v1_preview.png",dpi=110,bbox_inches="tight")
print("preview written")
