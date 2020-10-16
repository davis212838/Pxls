package space.pxls.server.packets.http;

import space.pxls.App;
import space.pxls.data.DBPixelPlacementUser;

public class Lookup {
    public int id;
    public int x;
    public int y;
    public boolean modAction;
    public int pixel_count;
    public int pixel_count_alltime;
    public long time;
    public String username;
    public String discordName = null;
    public String faction;

    public Lookup(int id, int x, int y, boolean modAction, int pixel_count, int pixel_count_alltime, long time, String username, String discordName, String faction) {
        boolean isSnip = App.getConfig().getBoolean("oauth.snipMode");
        this.id = id;
        this.x = x;
        this.y = y;
        this.modAction = modAction;
        this.pixel_count = isSnip ? 0 : pixel_count;
        this.pixel_count_alltime = isSnip ? 0 : pixel_count_alltime;
        this.time = time;
        this.username = isSnip ? "-snip-" : username;
        this.discordName = isSnip ? (discordName != null ? "-snip-" : null) : discordName; // if we're in snip mode, we want to filter the name, otherwise we'll just accept whatever was thrown at us. original serialization utilized nulls.
        this.faction = faction;
    }

    public static Lookup fromDB(DBPixelPlacementUser pixelPlacementUser) {
        if (pixelPlacementUser == null) return null;
        return new Lookup(pixelPlacementUser.id, pixelPlacementUser.x, pixelPlacementUser.y, pixelPlacementUser.modAction, pixelPlacementUser.pixel_count, pixelPlacementUser.pixel_count_alltime, pixelPlacementUser.time, pixelPlacementUser.username, pixelPlacementUser.discordName, pixelPlacementUser.faction);
    }
}
